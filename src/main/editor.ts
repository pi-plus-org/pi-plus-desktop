/**
 * External editor bridge for the composer: writes the draft to a temp file,
 * runs the configured editor command on it, and returns the file content once
 * the process exits. GUI editors need a blocking flag (`code --wait`);
 * terminal editors run without a TTY and are not usable here.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const KNOWN_EDITORS: { label: string; command: string }[] = [
	{ label: "VS Code", command: "code --wait" },
	{ label: "VSCodium", command: "codium --wait" },
	{ label: "Cursor", command: "cursor --wait" },
	{ label: "Zed", command: "zed --wait" },
	{ label: "Sublime Text", command: "subl --wait" },
	{ label: "BBEdit", command: "bbedit --wait" },
	{ label: "TextMate", command: "mate -w" },
	{ label: "GVim/MacVim", command: "gvim -f" },
	{ label: "gedit", command: "gedit -w" },
];

// GUI-launched apps (Finder/Dock/open) get a minimal PATH that excludes the
// usual CLI-install dirs, so probing PATH alone under-detects and a bare
// command then fails at spawn time. Fall back to these well-known bin dirs.
const EXTRA_BIN_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

/** Absolute path of a command, searched on PATH then in common bin dirs. */
function resolveProgram(program: string): string | undefined {
	if (program.includes("/")) return existsSync(program) ? program : undefined;
	const probe = process.platform === "win32" ? "where" : "which";
	try {
		const hit = spawnSync(probe, [program], { encoding: "utf8" }).stdout?.split("\n")[0]?.trim();
		if (hit) return hit;
	} catch {
		// no `which`/`where`; fall through to the fixed dirs
	}
	if (process.platform === "win32") return undefined;
	for (const dir of EXTRA_BIN_DIRS) {
		const candidate = join(dir, program);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Installed blocking-GUI editors for the Settings picker ("" = $VISUAL/$EDITOR
 *  fallback is added by the UI, not probed here). Commands carry absolute
 *  paths so spawning works no matter how the app was launched. */
export function listAvailableEditors(): { label: string; command: string }[] {
	return KNOWN_EDITORS.flatMap((e) => {
		const [program, ...flags] = e.command.split(" ");
		if (!program) return [];
		const resolved = resolveProgram(program);
		return resolved ? [{ label: e.label, command: [resolved, ...flags].join(" ") }] : [];
	});
}

/** The configured command, or $VISUAL/$EDITOR when none is set. */
export function resolveEditorCommand(configured: string): string | undefined {
	return configured.trim() || process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || undefined;
}

export async function openInEditor(configured: string, text: string): Promise<string | undefined> {
	const command = resolveEditorCommand(configured);
	if (!command) throw new Error('No editor configured — set one under Settings → Editors (e.g. "code --wait").');
	const [program, ...args] = splitCommand(command);
	if (!program) throw new Error(`Invalid editor command: '${command}'`);
	// A legacy bare command (e.g. "code --wait") may be unresolvable under a
	// minimal GUI PATH — try the common bin dirs before spawning.
	const resolvedProgram = resolveProgram(program);
	if (!resolvedProgram && !program.includes("/"))
		throw new Error(`Editor program '${program}' was not found (command: '${command}'). Pick an editor under Settings → Editors.`);
	const dir = mkdtempSync(join(tmpdir(), "pi-plus-edit-"));
	const file = join(dir, "prompt.md");
	writeFileSync(file, text, "utf-8");
	try {
		await new Promise<void>((resolve, reject) => {
			// Plain ChildProcess typing: with stdio:"ignore" the generic overload
			// union collapses awkwardly, and we only need event listeners here.
			const child: ChildProcess = spawn(resolvedProgram ?? program, [...args, file], { stdio: "ignore" });
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
