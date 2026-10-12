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

export class PackageStore {
	/** Serializes install/remove/update so concurrent ops can never interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private pushProgress: (event: PackageProgressDTO) => void) {}

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
	 * null when unavailable — the renderer shows these and gates inputs.
	 */
	checkTools(): { npm: string | null; git: string | null } {
		return { npm: findOnPath("npm"), git: findOnPath("git") };
	}

	/** Adds the source, installs it, and resolves to the fresh list. */
	install(source: string): Promise<PackageDTO[]> {
		const normalized = normalizeSource(source);
		return this.enqueue(async () => {
			try {
				await sdk.installPackage(normalized, {
					onProgress: (event) => this.pushProgress(event),
				});
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
			} catch (err) {
				rewordSpawnError(err);
			}
			return this.list();
		});
	}

	/** Tail-chain mutex shared by all three mutations. */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const next = this.queue.then(op, op);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
