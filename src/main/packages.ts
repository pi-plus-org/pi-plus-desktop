// PackageStore — SDK-backed facade for the Settings → Packages pane.
//
// pi packages are global: with PI_CODING_AGENT_DIR unset in the desktop main
// process, the SDK maintenance defaults (agentDir = getAgentDir()) resolve to
// the shared base agent dir (~/.pi/agent), matching the CLI's `pi install`.
import "./sdk-shim.ts";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { PackageDTO, PackageProgressDTO } from "../shared/ipc-types.ts";

const sdk = await import("pi-plus-sdk");

/**
 * Local-path sources are stored relative to the process cwd; the desktop main
 * process cwd is just wherever the app was launched from, so absolutize them
 * (with ~ expansion) to keep the stored declaration stable. npm/git sources
 * pass through untouched.
 */
function normalizeSource(source: string): string {
	if (source === "~" || source.startsWith("~/")) return path.resolve(os.homedir(), source.slice(2));
	if (
		source.startsWith("/") ||
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("." + path.sep) ||
		source.startsWith(".." + path.sep)
	)
		return path.resolve(process.cwd(), source);
	return source;
}

/**
 * The SDK shells out to npm/git (and npm's shebang needs node on PATH), so a
 * desktop-only install without those tools fails with a raw `spawn ENOENT`.
 * Reword that into an actionable message; anything else passes through.
 */
function rewordSpawnError(err: unknown): never {
	const message = err instanceof Error ? err.message : String(err);
	const match = message.match(/spawn\s+(\S+)\s+ENOENT/);
	if (match) {
		const tool = match[1];
		let hint: string;
		if (tool === "npm" || tool === "npx" || tool === "node") {
			hint = "Node.js (which includes npm) is required for npm packages — install it from https://nodejs.org or with `brew install node`, then restart the app.";
		} else if (tool === "git") {
			hint = "git is required for this package — install it with `xcode-select --install` or from https://git-scm.com, then restart the app.";
		} else {
			hint = `'${tool}' was not found on PATH. Install it and restart the app.`;
		}
		throw new Error(`${hint} (spawn ${tool} ENOENT)`);
	}
	throw err instanceof Error ? err : new Error(message);
}

/** Resolve a CLI tool to an absolute path on the (startup-repaired) PATH. */
function findOnPath(bin: string): string | null {
	const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const full = path.join(dir, name);
			if (existsSync(full)) return full;
		}
	}
	return null;
}

interface ToolSetting {
	mode: "auto" | "manual";
	path: string;
}

/** Read the piPlus `packageTools` block the settings layer persists (defensive parse). */
function toolSettings(): Record<"npm" | "git", ToolSetting> {
	const block = sdk.readPiPlusSettings().packageTools as { npm?: unknown; git?: unknown } | undefined;
	const parse = (value: unknown): ToolSetting => {
		if (typeof value === "object" && value !== null) {
			const { mode, path: toolPath } = value as { mode?: unknown; path?: unknown };
			if (mode === "manual" && typeof toolPath === "string" && toolPath.trim() !== "") {
				return { mode: "manual", path: toolPath.trim() };
			}
		}
		return { mode: "auto", path: "" };
	};
	return { npm: parse(block?.npm), git: parse(block?.git) };
}

/**
 * Resolve one tool honoring its setting: manual mode checks the configured
 * binary path itself (win32: .exe/.cmd variants when it has no extension),
 * auto mode probes PATH.
 */
function resolveTool(bin: "npm" | "git"): string | null {
	const setting = toolSettings()[bin];
	if (setting.mode === "manual") {
		const candidates =
			process.platform === "win32" && !/\.(exe|cmd)$/i.test(setting.path)
				? [setting.path, `${setting.path}.exe`, `${setting.path}.cmd`]
				: [setting.path];
		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}
	return findOnPath(bin);
}

export class PackageStore {
	/** Serializes install/remove/update so concurrent ops can never interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	/**
	 * Fired (main side) after any successful install/remove/update. The app
	 * uses it to prompt for restarting open sessions — extensions are loaded
	 * and bound at session creation, so only fresh sessions see the change.
	 */
	onChanged?: () => void;

	constructor(private pushProgress: (event: PackageProgressDTO) => void) {}

	/**
	 * Drop every cached extension factory so the next session rebuilds them
	 * from disk. Matters for updates/removals: factories are cached per
	 * resolved path for the life of the process, so without this a new session
	 * could keep running the pre-update code. Structural call because the
	 * SDK's nested coding-agent type copy may lag the runtime bundle; older
	 * SDKs without the export are tolerated (re-resolving the package list
	 * already covers installs).
	 */
	private clearExtensionFactories(): void {
		const maybe = sdk as unknown as { clearExtensionCache?: () => void };
		maybe.clearExtensionCache?.();
	}

	/** Configured packages from the base settings.json (sync SDK call). */
	list(): PackageDTO[] {
		return sdk.listPackages().map(({ source, scope, filtered, installedPath }) => ({
			source,
			scope,
			filtered,
			installedPath,
		}));
	}

	/**
	 * Absolute paths of the CLI tools package ops shell out to (npm/git), or
	 * null when unavailable — the renderer gates inputs on these. Honors the
	 * per-tool location setting (auto PATH probe vs. manual binary path).
	 */
	checkTools(): { npm: string | null; git: string | null } {
		return { npm: resolveTool("npm"), git: resolveTool("git") };
	}

	/** Adds the source, installs it, and resolves to the fresh list. */
	install(source: string): Promise<PackageDTO[]> {
		const normalized = normalizeSource(source);
		return this.enqueue(async () => {
			try {
				await sdk.installPackage(normalized, {
					onProgress: (event) => this.pushProgress(event),
				});
				this.clearExtensionFactories();
				this.onChanged?.();
			} catch (err) {
				rewordSpawnError(err);
			}
			return this.list();
		});
	}

	/** Removes the source's declaration and checkout; resolves to the fresh list. */
	remove(source: string): Promise<PackageDTO[]> {
		return this.enqueue(async () => {
			try {
				const removed = await sdk.removePackage(source);
				if (!removed) throw new Error(`'${source}' is not a configured package.`);
				this.clearExtensionFactories();
				this.onChanged?.();
			} catch (err) {
				rewordSpawnError(err);
			}
			return this.list();
		});
	}

	/** Upgrades one package (source given) or all of them; resolves to the fresh list. */
	update(source?: string): Promise<PackageDTO[]> {
		return this.enqueue(async () => {
			try {
				await sdk.updatePackages(source, {
					onProgress: (event) => this.pushProgress(event),
				});
				this.clearExtensionFactories();
				this.onChanged?.();
			} catch (err) {
				rewordSpawnError(err);
			}
			return this.list();
		});
	}

	/**
	 * Manual tool locations must be visible to the child processes the SDK
	 * spawns (npm's shebang also needs node, which usually sits next to npm) —
	 * so prepend their directories to PATH for the duration of an op. The queue
	 * serializes ops, which makes mutating the process env here race-free.
	 */
	private async withManualToolPath<T>(op: () => Promise<T>): Promise<T> {
		const dirs: string[] = [];
		for (const tool of ["npm", "git"] as const) {
			const setting = toolSettings()[tool];
			if (setting.mode === "manual") {
				const resolved = resolveTool(tool);
				if (resolved) dirs.push(path.dirname(resolved)); // missing binary adds nothing
			}
		}
		if (dirs.length === 0) return op();
		const oldPath = process.env.PATH;
		process.env.PATH = [...new Set(dirs), oldPath ?? ""].join(path.delimiter);
		try {
			return await op();
		} finally {
			process.env.PATH = oldPath;
		}
	}

	/** Tail-chain mutex shared by all three mutations. */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const next = this.queue.then(() => this.withManualToolPath(op), () => this.withManualToolPath(op));
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
