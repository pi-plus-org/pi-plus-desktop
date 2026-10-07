#!/usr/bin/env node
// Harvests a staged Windows app tree (devops/scripts/pack-windows.sh step 3-4)
// into a single WiX source file for msitools' `wixl` linker, which produces the
// per-machine MSI. One component per directory (a directory's files share the
// component) keeps the component count at the ~1.4k directory count instead of
// 16k+ per-file components — repair granularity is coarser, which is fine for
// an Electron runtime tree.
//
// wixl is a WiX subset, so the document sticks to constructs verified against
// msitools 0.106 (tools/wixl/{wix,builder}.vala):
//   - no special-folder id magic: wixl writes Directory @Name verbatim into
//     the Directory table's DefaultDir. The Windows Installer engine anchors
//     a row only when that DefaultDir is a bracketed property reference, so
//     predefined folders MUST carry Name="[ProgramFiles64Folder]"-style
//     values (a bare id with no Name resolves to "." and the tree lands
//     under TARGETDIR's fallback working directory — installs "nowhere").
//   - Guid="*" is deterministic (uuid from the component's element path) but
//     REQUIRES a KeyPath child — a component whose only content is
//     CreateFolder fails to link ("a child is needed to generate a component
//     GUID"), hence the registry KeyPath on the shortcut component.
//   - shortcuts: wixl writes @Target verbatim into the Shortcut row. A target
//     of "[#<FileId>]" is a regular (non-advertised) shortcut resolved by the
//     engine at CreateShortcuts time; a bare Feature id would be an advertised
//     shortcut whose entry point is the KeyPath of ITS OWN component (here a
//     registry value — clicking it would fail), so always use the [#…] form.
//     The Advertise attribute itself is unimplemented in wixl (passing "no"
//     just logs "unimplemented") — @Target is what controls the row.
//   - `$(…)` is preprocessor syntax: every emitted value gets $ doubled.
//
// Usage:
//   node devops/scripts/win-wxs.mjs --stage <APP_DIR> --out <file.wxs> \
//     --icon <icon.ico> --name <App> --msi-version <x.y.z> --exe <file.exe>

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MANUFACTURER = "Pi+";
// Stable across releases — replaces the old product on every version bump.
// NEVER change (MSI UpgradeCode identity).
const UPGRADE_CODE = "3df5d9a0-4cea-472c-a173-2fe92abf16eb";

const log = (msg) => console.error(`[wxs] ${msg}`);
const die = (msg) => {
  log(`refusing: ${msg}`);
  process.exit(1);
};

// --- args -------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith("--") || process.argv[i + 1] === undefined) die(`bad argument ${key}`);
  args[key.slice(2)] = process.argv[++i];
}
for (const need of ["stage", "out", "icon", "name", "msi-version"]) {
  if (!args[need]) die(`missing --${need}`);
}
const STAGE = resolve(args.stage);
const NAME = args.name;
const MSI_VERSION = args["msi-version"];
const EXE_FILE = args.exe || "pi-plus.exe"; // app exe at the stage root
if (!/^\d+\.\d+\.\d+$/.test(MSI_VERSION)) die(`msi-version must be numeric major.minor.build, got '${MSI_VERSION}'`);
try {
  readFileSync(resolve(args.icon)); // fail fast on a bad icon path
} catch {
  die(`icon not readable: ${args.icon}`);
}
try {
  statSync(join(STAGE, EXE_FILE)); // the Start-menu shortcut must have a target
} catch {
  die(`app exe not found at stage root: ${join(STAGE, EXE_FILE)}`);
}

// --- helpers ----------------------------------------------------------------
// MSI identifiers: leading alpha, then [A-Za-z0-9_], <= 72 chars. Hashing the
// stage-relative path keeps ids stable across machines and releases.
const msiId = (prefix, relPath) =>
  prefix + createHash("sha256").update(relPath.split("/").join("\n")).digest("hex").slice(0, 24);

// $ doubling must precede XML escaping (wixl preprocessor), and "&" must be
// escaped last or the inserted entities would double-escape.
const attr = (value) =>
  value
    .replace(/\$/g, () => "$$")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const assertSafe = (name) => {
  if (!/^[\x20-\x7e]*$/.test(name)) die(`non-ASCII path segment: ${name}`);
};

// --- harvest ----------------------------------------------------------------
// Recursively emit <Directory> elements for `dir`, each directory holding its
// own files as one <Component>; returns { xml, components: [id] }.
function harvestDir(absDir, relPath, indent) {
  const pad = " ".repeat(indent);
  const entries = readdirSync(absDir, { withFileTypes: true });

  const seen = new Map();
  const files = [];
  const dirs = [];
  for (const entry of entries) {
    const childAbs = join(absDir, entry.name);
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) die(`symlink in payload: ${childAbs}`);
    assertSafe(childRel);
    if (entry.isDirectory()) dirs.push({ entry, childAbs, childRel });
    else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (seen.has(lower)) die(`case-variant collision in ${absDir}: ${seen.get(lower)} / ${entry.name}`);
      seen.set(lower, entry.name);
      files.push({ entry, childAbs, childRel });
    } // sockets/fifos etc: not installable — skip silently (none expected)
  }
  files.sort((a, b) => (a.entry.name < b.entry.name ? -1 : 1));
  dirs.sort((a, b) => (a.entry.name < b.entry.name ? -1 : 1));

  const components = [];
  let xml = "";
  if (files.length > 0) {
    const compId = msiId("C", relPath);
    components.push(compId);
    xml += `${pad}<Component Id="${compId}" Guid="*">\n`;
    files.forEach(({ entry, childAbs, childRel }, i) => {
      const keyPath = i === 0 ? ' KeyPath="yes"' : "";
      xml += `${pad}  <File Id="${msiId("F", childRel)}" Name="${attr(entry.name)}" Source="${attr(childAbs)}"${keyPath}/>\n`;
    });
    xml += `${pad}</Component>\n`;
  }
  for (const { entry, childAbs, childRel } of dirs) {
    const dirId = msiId("D", childRel);
    const child = harvestDir(childAbs, childRel, indent + 2);
    components.push(...child.components);
    xml += `${pad}<Directory Id="${dirId}" Name="${attr(entry.name)}">\n${child.xml}${pad}</Directory>\n`;
  }
  return { xml, components };
}

try {
  statSync(STAGE);
} catch {
  die(`stage dir not found: ${STAGE}`);
}
assertSafe(STAGE); // must live under an ASCII path (wixl Source refs)
const tree = harvestDir(STAGE, "", 10);

// --- document ---------------------------------------------------------------
const menuCompId = msiId("C", "\x01startmenu"); // namespace-safe, stable
const doc = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${attr(NAME)}" Language="1033" Version="${attr(MSI_VERSION)}" Manufacturer="${attr(MANUFACTURER)}" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="200" Compressed="yes" InstallScope="perMachine"/>
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of [ProductName] is already installed."/>
    <MediaTemplate EmbedCab="yes"/>
    <Icon Id="AppIco" SourceFile="${attr(resolve(args.icon))}"/>
    <Property Id="ARPPRODUCTICON" Value="AppIco"/>
    <Feature Id="ProductFeature" Title="${attr(NAME)}" Level="1">
      <ComponentRef Id="${menuCompId}"/>
${tree.components.map((id) => `      <ComponentRef Id="${id}"/>`).join("\n")}
    </Feature>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder" Name="[ProgramFiles64Folder]">
        <Directory Id="INSTALLDIR" Name="${attr(NAME)}">
${tree.xml}        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder" Name="[ProgramMenuFolder]">
        <Directory Id="AppMenuDir" Name="${attr(NAME)}">
          <Component Id="${menuCompId}" Guid="*">
            <RegistryKey Root="HKCU" Key="Software\\${attr(MANUFACTURER)}\\${attr(NAME)}">
              <RegistryValue Name="Version" Value="[ProductVersion]" Type="string" KeyPath="yes"/>
            </RegistryKey>
            <CreateFolder/>
            <RemoveFolder Id="RF_menu" On="uninstall"/>
            <Shortcut Id="SC_app" Name="${attr(NAME)}" Target="[#${msiId("F", EXE_FILE)}]" Icon="AppIco" IconIndex="0" WorkingDirectory="INSTALLDIR"/>
          </Component>
        </Directory>
      </Directory>
    </Directory>
  </Product>
</Wix>
`;
writeFileSync(args.out, doc);

// --- report -----------------------------------------------------------------
const fileCount = tree.components.length > 0 ? (doc.match(/<File /g) ?? []).length : 0;
log(`${fileCount} files in ${tree.components.length} components -> ${args.out}`);
