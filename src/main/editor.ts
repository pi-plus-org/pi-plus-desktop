/**
 * External editor bridge for the composer: writes the draft to a temp file,
 * runs the configured editor command on it, and returns the file content once
 * the process exits. GUI editors need a blocking flag (`code --wait`, `gvim -f`);
 * terminal editors run without a TTY and are not usable here.
 *
 * There is no system fallback ($VISUAL/$EDITOR): the editor is picked
 * explicitly under Settings → Editors and must resolve to a launchable binary.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Split a command line into program + fixed args; quoted segments keep spaces. */
function splitCommand(command: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command))) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	return tokens;
}

// GUI editors that accept a file path and can block until the file is closed
// (needed because we read the temp file after the process exits). Terminal
// editors are deliberately absent: no TTY here.
const KNOWN_EDITORS: { label: string; program: string; flags: string[] }[] = [
	{ label: "VS Code", program: "code", flags: ["--wait"] },
	{ label: "VSCodium", program: "codium", flags: ["--wait"] },
	{ label: "Cursor", program: "cursor", flags: ["--wait"] },
	{ label: "Zed", program: "zed", flags: ["--wait"] },
	{ label: "Sublime Text", program: "subl", flags: ["--wait"] },
	{ label: "BBEdit", program: "bbedit", flags: ["--wait"] },
	{ label: "TextMate", program: "mate", flags: ["-w"] },
	{ label: "GVim/MacVim", program: "gvim", flags: ["-f"] },
	{ label: "gedit", program: "gedit", flags: ["-w"] },
];

// GUI-launched apps (Finder/Dock/Start menu) get a minimal PATH that excludes
// the usual CLI-install dirs, so probing PATH alone under-detects and a bare
// command then fails at spawn time. Fall back to these well-known bin dirs.
export const EXTRA_BIN_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

// On Windows an editor is a .exe or a .cmd shim (`code.cmd`); the extensionless
// file VS Code's bin dir also ships is a bash script that cannot be spawned.
const WIN_EXTS = [".exe", ".cmd", ".bat", ".com", ""];

/** Vim nests its binary under `vim<major><minor>`, so expand those subdirs. */
function vimBinDirs(): string[] {
	const localAppData = process.env.LOCALAPPDATA;
	const roots = [
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Vim"),
		process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"] as string, "Vim"),
		localAppData && join(localAppData, "Programs", "Vim"),
	].filter((dir): dir is string => typeof dir === "string");
	const dirs: string[] = [];
	for (const root of roots) {
		dirs.push(root);
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory() && /^vim\d/i.test(entry.name)) dirs.push(join(root, entry.name));
			}
		} catch {
			// not installed here
		}
	}
	return dirs;
}

/** Well-known install dirs for this platform (GUI launches miss the CLI PATH). */
function extraBinDirs(): string[] {
	if (process.platform !== "win32") return EXTRA_BIN_DIRS;
	const localAppData = process.env.LOCALAPPDATA;
	const dirs = [
		localAppData && join(localAppData, "Programs", "Microsoft VS Code", "bin"),
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft VS Code", "bin"),
		process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"] as string, "Microsoft VS Code", "bin"),
		localAppData && join(localAppData, "Programs", "VSCodium", "bin"),
		localAppData && join(localAppData, "Programs", "cursor", "resources", "app", "bin"),
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Sublime Text"),
		localAppData && join(localAppData, "Programs", "Zed"),
		...vimBinDirs(),
	].filter((dir): dir is string => typeof dir === "string");
	return [...new Set(dirs)];
}

/** PATH entries, trimmed and unquoted (Windows installers happily quote them). */
function pathDirs(): string[] {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
		.filter((dir) => dir !== "");
}

/** Absolute path of a command, searched on PATH then in common bin dirs. */
function resolveProgram(program: string): string | undefined {
	if (program.includes("/") || program.includes("\\")) return existsSync(program) ? program : undefined;
	if (process.platform === "win32") {
		for (const dir of [...pathDirs(), ...extraBinDirs()]) {
			for (const ext of WIN_EXTS) {
				const candidate = join(dir, program + ext);
				if (existsSync(candidate)) return candidate;
			}
		}
		return undefined;
	}
	try {
		const hit = spawnSync("which", [program], { encoding: "utf8" }).stdout?.split("\n")[0]?.trim();
		if (hit) return hit;
	} catch {
		// no `which`; fall through to the fixed dirs
	}
	for (const dir of EXTRA_BIN_DIRS) {
		const candidate = join(dir, program);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Quote a program path for the persisted command line (spaces are common in
 *  Windows install dirs and macOS .app bundles). */
function quoteCommandPath(path: string): string {
	return /\s/.test(path) ? `"${path}"` : path;
}

/** Installed blocking-GUI editors for the Settings picker. Commands carry
 *  absolute paths so spawning works no matter how the app was launched. */
export function listAvailableEditors(): { label: string; command: string }[] {
	return KNOWN_EDITORS.flatMap((e) => {
		const resolved = resolveProgram(e.program);
		return resolved ? [{ label: e.label, command: [quoteCommandPath(resolved), ...e.flags].join(" ") }] : [];
	});
}

/** Quote one arg for a cmd.exe command line (only used for .cmd/.bat shims). */
function quoteArg(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export async function openInEditor(configured: string, text: string): Promise<string | undefined> {
	const command = configured.trim();
	if (!command) throw new Error("No external editor selected — pick one under Settings → Editors.");
	const [program, ...args] = splitCommand(command);
	if (!program) throw new Error(`Invalid editor command: '${command}'`);
	// A saved command carries an absolute path, but re-resolve anyway: the app
	// may have been installed/moved since it was picked.
	const resolvedProgram = resolveProgram(program);
	if (!resolvedProgram) throw new Error(`Editor program '${program}' was not found (command: '${command}'). Pick an editor under Settings → Editors.`);
	const dir = mkdtempSync(join(tmpdir(), "pi-plus-edit-"));
	const file = join(dir, "prompt.md");
	writeFileSync(file, text, "utf-8");
	try {
		await new Promise<void>((resolve, reject) => {
			// Plain ChildProcess typing: with stdio:"ignore" the generic overload
			// union collapses awkwardly, and we only need event listeners here.
			const argv = [...args, file];
			// Node refuses to spawn .cmd/.bat without a shell (EINVAL), so run the
			// shim through cmd.exe with a quoted command line.
			const child: ChildProcess =
				process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedProgram)
					? spawn([resolvedProgram, ...argv].map(quoteArg).join(" "), { shell: true, stdio: "ignore", windowsHide: true })
					: spawn(resolvedProgram, argv, { stdio: "ignore" });
			child.on("error", (err) => reject(new Error(`Failed to launch '${command}': ${err.message}`)));
			child.on("exit", (code, signal) => {
				if (code === 0) resolve();
				else reject(new Error(`Editor exited with ${signal ?? code} (command: '${command}'). Check Settings → Editors.`));
			});
		});
		const edited = readFileSync(file, "utf-8");
		return edited.trim() ? edited : undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
