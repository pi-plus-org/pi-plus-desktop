// McpStore — SDK-backed facade for the Settings → MCP pane.
//
// Everything the pane needs is already an API on pi-plus-sdk (listMcpServers,
// addMcpServer, updateMcpServer, removeMcpServer, checkMcpServers,
// loginMcpServer, logoutMcpServer, listMcpCredentials, getMcpConfigPaths,
// validateMcpServer); this file only shapes those into IPC-safe DTOs and
// serializes the writes.
//
// Why the serialization matters: the SDK edits mcp.json with a plain
// read → JSON.parse → mutate → writeFileSync (no lock, no atomic rename), so
// two concurrent mutations — or a mutation racing a `pipi` CLI edit — lose an
// update. Every write here runs through one queue, and every write hands back
// the fresh snapshot so the pane never paints a stale view.
//
// The desktop main process leaves PI_CODING_AGENT_DIR unset, so the "no
// profile" target resolves to the shared base agent dir (~/.pi/agent) — the
// same file the CLI's `pi mcp add` writes. A profile target passes that
// profile's materialized dir instead, since that is the dir the tab's session
// runs under (SessionHost asks ProfileStore for it at session creation).
import "./sdk-shim.ts";
import { shell } from "electron";
import type {
	McpCheckResultDTO,
	McpCredentialDTO,
	McpPatchScopeDTO,
	McpServerDTO,
	McpSnapshotDTO,
	McpStatusDTO,
	McpTargetDTO,
} from "../shared/ipc-types.ts";

// The SDK surface is loaded dynamically (after the shim above has installed the
// pi-plus resolution) and kept as one module namespace.
const sdk = await import("pi-plus-sdk");

type LoadedMcpConfig = ReturnType<typeof sdk.listMcpServers>;
type McpServerEntry = LoadedMcpConfig["servers"][number];
type McpOptions = NonNullable<Parameters<typeof sdk.listMcpServers>[0]>;
/** The four server-level exposures pi recognises (the patch is typed against them). */
type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
// A raw mcp.json entry: validated by the SDK before it reaches disk, so this
// side stays deliberately permissive (anything the JSON editor can express).
type RawEntry = Record<string, unknown>;

export class McpStore {
	/** Tail of the write queue; every mutation awaits it before touching disk. */
	private queue: Promise<unknown> = Promise.resolve();

	/** Map a profile name (undefined = the base agent dir) onto its agent dir.
	 * Injected because ProfileStore owns that resolution — and materializing a
	 * profile dir is exactly what a tab would have done to use it. */
	constructor(private profileAgentDir: (profile?: string) => string) {}

	// --- reads ------------------------------------------------------------

	/** The merged config pi would start a session from, plus the two file paths. */
	snapshot(target: McpTargetDTO): McpSnapshotDTO {
		const options = this.options(target);
		const loaded = sdk.listMcpServers(options);
		const paths = sdk.getMcpConfigPaths(options);
		return {
			servers: loaded.servers.map((entry) => this.toServerDTO(entry)),
			errors: loaded.errors,
			paths,
			note: this.trustNote(target),
		};
	}

	/**
	 * Connect to every enabled server and report the live state. This spawns
	 * stdio children and opens HTTP connections (pi's own 60 s per-request
	 * timeout), so it is on demand only — never a background poll. No mcp.json
	 * writes happen here, but a token refresh may write mcp-auth.json.
	 */
	async check(target: McpTargetDTO): Promise<McpCheckResultDTO> {
		const result = await sdk.checkMcpServers(this.options(target));
		const statuses: McpStatusDTO[] = result.servers.map((server) => ({
			name: server.name,
			state: server.state,
			transport: server.transport,
			tools: server.tools,
			resources: server.resources,
			error: server.error,
		}));
		return { statuses, errors: result.errors, note: this.trustNote(target) };
	}

	/** Stored OAuth records. pi reads mcp-auth.json with a bare JSON.parse, so a
	 * malformed file surfaces as a readable message instead of a raw stack. */
	credentials(target: McpTargetDTO): McpCredentialDTO[] {
		try {
			return sdk.listMcpCredentials(this.options(target));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Cannot read the credential store for this agent dir: ${message}`);
		}
	}

	// --- writes (serialized; each returns the fresh snapshot) -------------

	/**
	 * Run `mutate` after the queue settles, then re-read the config. The write
	 * itself is synchronous SDK code; queueing it behind a microtask boundary is
	 * what keeps two IPC handlers from interleaving their read-modify-writes.
	 */
	private async write(mutate: () => unknown, target: McpTargetDTO): Promise<McpSnapshotDTO> {
		const run = this.queue.then(() => mutate());
		// Keep the chain alive even when this mutation fails, or every later one
		// would reject with the same stale error.
		this.queue = run.catch(() => undefined);
		await run;
		return this.snapshot(target);
	}

	/** Add (or replace) a server in the targeted file, then return the fresh view. */
	add(name: string, config: unknown, target: McpTargetDTO): Promise<McpSnapshotDTO> {
		// Validate before queueing: a rejected edit must not sit in the write chain,
		// and pi's own rules are the only rules the editor should answer to.
		const validated = sdk.validateMcpServer(name, config);
		if (typeof validated === "string") throw new Error(validated);
		return this.write(() => sdk.addMcpServer(name, validated, this.editOptions(target)), target);
	}

	/** Remove a server from the targeted file only (credentials stay put). */
	remove(name: string, target: McpTargetDTO): Promise<McpSnapshotDTO> {
		return this.write(() => sdk.removeMcpServer(name, this.editOptions(target)), target);
	}

	/** Patch enabled/exposure of an existing server. */
	patch(
		name: string,
		patch: { enabled?: boolean; exposure?: string },
		scope: McpPatchScopeDTO,
		target: McpTargetDTO,
	): Promise<McpSnapshotDTO> {
		return this.write(() => this.patchSync(name, patch, scope, target), target);
	}

	/** Validate a raw entry without writing it (the editor checks on every keystroke).
	 * The SDK returns either the parsed config or the error message. */
	validate(name: string, config: unknown): string | null {
		const result = sdk.validateMcpServer(name, config);
		return typeof result === "string" ? result : null;
	}

	/** Forget a server's stored credentials. */
	logout(name: string, target: McpTargetDTO): boolean {
		return sdk.logoutMcpServer(name, this.options(target));
	}

	private patchSync(
		name: string,
		patch: { enabled?: boolean; exposure?: string },
		scope: McpPatchScopeDTO,
		target: McpTargetDTO,
	): void {
		// The SDK patch only carries enabled/exposure; anything else is a config
		// change and must come through the editor (addMcpServer replaces).
		const shaped: { enabled?: boolean; exposure?: "hidden" | "direct" | "deferred" | "codemode" } = {};
		if (typeof patch.enabled === "boolean") shaped.enabled = patch.enabled;
		if (patch.exposure) shaped.exposure = patch.exposure as McpExposure;
		sdk.updateMcpServer(
			name,
			shaped,
			// "auto" = omit the scope: pi patches the file that defines/overrides the
			// server. The UI's "global" is pi's "user" (the agent-dir file).
			scope === "auto"
				? this.options(target)
				: { ...this.options(target), scope: scope === "global" ? ("user" as const) : ("project" as const) },
		);
	}

	// --- auth --------------------------------------------------------------

	/**
	 * Drive pi's OAuth sign-in for one server. The flow is headless: it builds
	 * its own connection and waits on a loopback callback, with `openUrl` handing
	 * the authorization URL to the OS browser (the same escape hatch the CLI uses
	 * when there is no terminal to print into).
	 */
	async login(name: string, target: McpTargetDTO): Promise<string[]> {
		return sdk.loginMcpServer(name, {
			...this.options(target),
			openUrl: (url: string) => {
				void shell.openExternal(url).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					console.warn(`[mcp] could not open the sign-in URL: ${message}`);
				});
			},
		});
	}

	// --- plumbing ----------------------------------------------------------

	/** Only pass what the UI actually chose: an omitted cwd lets the SDK use its
	 * own default (process.cwd()) — which is why every target names a dir here. */
	private options(target: McpTargetDTO): McpOptions {
		const options: McpOptions = { agentDir: this.profileAgentDir(target.profile) };
		if (target.cwd) options.cwd = target.cwd;
		if (target.projectTrusted !== undefined) options.projectTrusted = target.projectTrusted;
		return options;
	}

	/** Writes choose the file: `local` is the SDK's global-vs-project switch, which
	 * only exists on the edit options, not on reads. A project write needs a
	 * project — silently falling back to process.cwd() would write next to the
	 * app binary in a packaged build, so this refuses instead. */
	private editOptions(target: McpTargetDTO): McpOptions & { local?: boolean } {
		if (target.local && !target.cwd) throw new Error("Project scope needs a project directory.");
		return { ...this.options(target), local: target.local };
	}

	/** checkMcpServers reports its own note for the same condition; for plain
	 * reads the SDK has no place to say it, so the pane needs it spelled out. */
	private trustNote(target: McpTargetDTO): string | undefined {
		return target.cwd && target.projectTrusted === false
			? "Project MCP config is ignored: the project is not trusted."
			: undefined;
	}

	private toServerDTO(entry: McpServerEntry): McpServerDTO {
		const config = entry.config as unknown as RawEntry;
		const command = typeof config.command === "string" ? config.command : undefined;
		const url = typeof config.url === "string" ? config.url : undefined;
		const headers = config.headers as Record<string, string> | undefined;
		const oauth = config.oauth as Record<string, unknown> | undefined;
		const auth = config.auth as { provider?: string } | undefined;
		return {
			name: entry.name,
			scope: entry.scope ?? (entry.override ? "project" : "global"),
			// enabled defaults to true: only an explicit false disables.
			enabled: config.enabled !== false,
			exposure: typeof config.exposure === "string" ? config.exposure : "codemode",
			transport: url ?? (command ? [command, ...normalizeArgs(config.args)].join(" ") : ""),
			kind: url ? "http" : command ? "stdio" : "override",
			// pi only signs in HTTP servers with no static credential: an
			// Authorization header or a configured provider already authenticates.
			oauth: Boolean(url) && !headers?.Authorization && !auth?.provider,
			overridden: Boolean(entry.override),
			source: entry.override ?? entry.source,
			config,
		};
	}
}

function normalizeArgs(args: unknown): string[] {
	return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
}
