/**
 * SessionHost: owns every agent session in the main process, one runtime per tab.
 *
 * A tab is created up front (cwd + profile); the SDK runtime is created
 * lazily on first prompt or on an explicit resume. The runtime — not a bare
 * AgentSession — is what lets tabs survive session replacement: /cd, clone,
 * and fork-from-message swap the session object under us, and `onRebind`
 * re-attaches the event subscription and pushes fresh meta each time.
 * Session events are sanitized and pushed to the renderer, keyed by tabId so
 * background tabs keep working while the user types elsewhere.
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { WebContents } from "electron";
import "./sdk-shim.ts";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, SessionInfo, SettingsManager } from "pi-plus-sdk";
import { composePromptText } from "../shared/attachments.ts";
import {
	IPC,
	type CommandDTO,
	type CompactResultDTO,
	type CompactionPatch,
	type CompactionSettingsDTO,
	type EnsureResult,
	type ForkTargetDTO,
	type ModelRefDTO,
	type QueueDTO,
	type SessionListItemDTO,
	type SessionMetaDTO,
	type SkillDTO,
	type TabDescriptor,
} from "../shared/ipc-types.ts";
import type { DialogBridge } from "./dialogs.ts";
import type { ProfileStore } from "./profiles.ts";
import { sanitizeEvent, sanitizeSnapshot } from "./session-sanitize.ts";

// Imported dynamically so the sdk-shim module (a static import above) installs
// the global require before pi-plus-sdk's ESM bundle evaluates — static imports
// of externals would be hoisted above the shim by the bundler.
const sdk = await import("pi-plus-sdk");
const {
	createPlusAgentSessionRuntime,
	SessionManager,
	getAutoCompactThresholdPercent,
	setAutoCompactThresholdPercent,
	getContextFloorTokens,
	setContextFloorTokens,
	getContextWindowCapTokens,
	setContextWindowCapTokens,
} = sdk;

interface TabHandle {
	tabId: string;
	cwd: string;
	profileName: string | null;
	agentDir: string;
	agentDirWarning?: string;
	runtime: AgentSessionRuntime | null;
	/** Re-attached on every rebind; the old AgentSession object is dead. */
	unsubscribe: (() => void) | null;
	lastStreaming: boolean;
	/** Last meta pushed, so refreshMeta() can skip unchanged payloads. */
	lastMetaJson: string;
}

const FORK_PREVIEW_LIMIT = 160;

function modelRef(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "";
}

/** SessionInfo (SDK) -> the sidebar row DTO; allMessagesText stays main-side. */
function toSessionListItem(info: SessionInfo): SessionListItemDTO {
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		name: info.name,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

export class SessionHost {
	private tabs = new Map<string, TabHandle>();

	constructor(
		private getWebContents: (tabId: string) => WebContents | undefined,
		private dialogs: DialogBridge,
		private profiles: ProfileStore,
	) {}

	createTab(opts: { cwd?: string; profileName?: string | null }): TabDescriptor {
		const profileName = opts.profileName ?? null;
		const cwd = opts.cwd ?? process.cwd();
		const { agentDir, error } = this.profiles.resolveAgentDir(profileName);
		const tabId = randomUUID();
		this.tabs.set(tabId, {
			tabId,
			cwd,
			profileName,
			agentDir,
			agentDirWarning: error,
			runtime: null,
			unsubscribe: null,
			lastStreaming: false,
			lastMetaJson: "",
		});
		return { tabId, cwd, profileName };
	}

	private getTab(tabId: string): TabHandle {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new Error(`Unknown tab '${tabId}'.`);
		return tab;
	}

	/** The tab's working directory (updated on resume and /cd) — the @-menu root. */
	cwdFor(tabId: string): string {
		return this.getTab(tabId).cwd;
	}

	/** Live session of a tab; throws when the runtime is missing. */
	private sessionOf(tab: TabHandle): AgentSession {
		const session = tab.runtime?.session;
		if (!session) throw new Error("Session not initialized.");
		return session;
	}

	/**
	 * Create the SDK runtime for a tab if needed. When resumePath is given the
	 * session is rebuilt around that transcript (messages + model/thinking are
	 * restored from disk by the SDK).
	 */
	async ensureSession(tabId: string, resumePath?: string): Promise<EnsureResult> {
		const tab = this.getTab(tabId);
		if (tab.runtime) {
			return this.describe(tab);
		}

		const sessionManager = resumePath ? SessionManager.open(resumePath, undefined, tab.cwd) : undefined;
		if (sessionManager) tab.cwd = sessionManager.getCwd();

		let runtime: AgentSessionRuntime;
		try {
			runtime = await createPlusAgentSessionRuntime({
				cwd: tab.cwd,
				agentDir: tab.agentDir,
				sessionManager,
				// The subagent tool spawns a `pi` subprocess; in this Electron host that
				// can relaunch the app binary, so it stays disabled.
				excludeTools: ["subagent"],
				ui: this.dialogs.handlersFor(tabId),
				onError: (error) => {
					this.push(tabId, { type: "extension_error", message: error.error });
				},
				// Fires for the initial bind and after every session replacement
				// (cd/clone/fork/switch): re-subscribe to the new live session.
				onRebind: (session) => {
					tab.unsubscribe?.();
					tab.unsubscribe = session.subscribe((event: AgentSessionEvent) => this.onSessionEvent(tab, event));
					tab.lastStreaming = session.isStreaming;
					this.refreshMeta(tab, session);
				},
			});
		} catch (err) {
			console.error(`[session] createPlusAgentSessionRuntime failed for tab ${tabId}: ${(err as Error).stack ?? err}`);
			throw err;
		}
		tab.runtime = runtime;

		const result = this.describe(tab);
		result.modelFallbackMessage = runtime.modelFallbackMessage;
		return result;
	}

	/** Full snapshot for IPC returns: meta + sanitized history. */
	private describe(tab: TabHandle, editorText?: string, cancelled?: boolean): EnsureResult {
		const session = this.sessionOf(tab);
		return {
			meta: this.buildMeta(tab, session),
			messages: sanitizeSnapshot(session.messages),
			editorText,
			cancelled,
		};
	}

	private buildMeta(tab: TabHandle, session: AgentSession): SessionMetaDTO {
		const usage = session.getContextUsage();
		return {
			cwd: tab.runtime?.cwd ?? tab.cwd,
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			sessionFile: session.sessionFile,
			model: modelRef(session.model),
			thinkingLevel: session.thinkingLevel,
			autoCompactionEnabled: session.autoCompactionEnabled,
			contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
			availableThinkingLevels: session.getAvailableThinkingLevels() as string[],
			persisted: !!session.sessionFile,
		};
	}

	/** Push meta only when it actually changed (entry_appended fires a lot). */
	private refreshMeta(tab: TabHandle, session?: AgentSession): void {
		const live = session ?? tab.runtime?.session;
		if (!live) return;
		const meta = this.buildMeta(tab, live);
		const json = JSON.stringify(meta);
		if (json === tab.lastMetaJson) return;
		tab.lastMetaJson = json;
		const webContents = this.getWebContents(tab.tabId);
		if (webContents && !webContents.isDestroyed()) {
			webContents.send(IPC.push.sessionMeta, { tabId: tab.tabId, meta });
		}
	}

	private onSessionEvent(tab: TabHandle, event: AgentSessionEvent): void {
		const raw = event as unknown as Record<string, unknown>;
		const sanitized = sanitizeEvent(raw);
		if (sanitized) this.push(tab.tabId, sanitized);

		// Meta-relevant events: usage/model/thinking/name/persisted flip.
		switch (event.type) {
			case "session_info_changed":
			case "thinking_level_changed":
			case "agent_settled":
			case "compaction_end":
			case "entry_appended":
				this.refreshMeta(tab);
				break;
			default:
				break;
		}

		const streaming = tab.runtime?.session.isStreaming ?? false;
		if (streaming !== tab.lastStreaming) {
			tab.lastStreaming = streaming;
			const webContents = this.getWebContents(tab.tabId);
			if (webContents && !webContents.isDestroyed()) {
				webContents.send(IPC.push.sessionStatus, { tabId: tab.tabId, isStreaming: streaming });
			}
		}
	}

	private push(tabId: string, event: unknown): void {
		const webContents = this.getWebContents(tabId);
		if (webContents && !webContents.isDestroyed()) {
			webContents.send(IPC.push.sessionEvent, { tabId, event });
		}
	}

	async prompt(tabId: string, text: string, attachments?: string[], mode?: "steer" | "followUp"): Promise<void> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		// ensureSession above guarantees the runtime exists; streamingBehavior
		// only matters while a turn is in flight (queued as steer/follow-up).
		await this.sessionOf(tab).prompt(composePromptText(text, attachments), { streamingBehavior: mode ?? "followUp" });
	}

	async abort(tabId: string): Promise<void> {
		const tab = this.getTab(tabId);
		if (tab.runtime) await tab.runtime.session.abort();
	}

	async compact(tabId: string, customInstructions?: string): Promise<CompactResultDTO> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		if (session.isStreaming) await session.waitForIdle();
		const result = await session.compact(customInstructions || undefined);
		this.refreshMeta(tab);
		const dto: CompactResultDTO = { tokensBefore: result.tokensBefore };
		if (result.estimatedTokensAfter !== undefined) dto.estimatedTokensAfter = result.estimatedTokensAfter;
		return dto;
	}

	async abortCompaction(tabId: string): Promise<void> {
		const tab = this.getTab(tabId);
		const session = tab.runtime?.session;
		if (session) session.abortCompaction();
	}

	async setAutoCompaction(tabId: string, enabled: boolean): Promise<boolean> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		// Writes the GLOBAL settings.json compaction flag for this agent dir.
		session.setAutoCompactionEnabled(enabled);
		this.refreshMeta(tab);
		return session.autoCompactionEnabled;
	}

	/** In-place clone: new transcript file, same history (CLI /clone parity). */
	async clone(tabId: string): Promise<EnsureResult> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		if (session.isStreaming) await session.waitForIdle();
		if (!session.sessionFile) throw new Error("Wait for the first assistant response before cloning this session.");
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Session has no leaf entry to clone from.");
		await tab.runtime!.fork(leafId, { position: "at" });
		return this.describe(tab);
	}

	/** Relocate the session to another folder via the /cd extension command. */
	async cd(tabId: string, dirPath: string): Promise<EnsureResult> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		const before = tab.runtime!.cwd;
		// The /cd handler resolves relative args against the current cwd and
		// does its own waitForIdle; spaces inside the path are preserved.
		await session.prompt(`/cd ${dirPath}`, { streamingBehavior: "followUp" });
		tab.cwd = tab.runtime!.cwd;
		if (tab.cwd === before) throw new Error(`Could not change folder to '${dirPath}'.`);
		return this.describe(tab);
	}

	async listForkTargets(tabId: string): Promise<ForkTargetDTO[]> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		return session.getUserMessagesForForking().map((entry) => ({
			entryId: entry.entryId,
			text: entry.text.length > FORK_PREVIEW_LIMIT ? `${entry.text.slice(0, FORK_PREVIEW_LIMIT)}…` : entry.text,
		}));
	}

	async forkFromMessage(tabId: string, entryId: string): Promise<EnsureResult> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		if (session.isStreaming) await session.waitForIdle();
		const result = await tab.runtime!.fork(entryId, { position: "before" });
		if (result.cancelled) return this.describe(tab, undefined, true);
		return this.describe(tab, result.selectedText);
	}

	async rewind(tabId: string, entryId: string, summarize: boolean): Promise<EnsureResult> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		if (session.isStreaming) await session.waitForIdle();
		const result = await session.navigateTree(entryId, { summarize });
		if (result.cancelled) return this.describe(tab, undefined, true);
		return this.describe(tab, result.editorText);
	}

	async renameSession(tabId: string, name: string): Promise<void> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		this.sessionOf(tab).setSessionName(name);
		this.refreshMeta(tab);
	}

	async clearQueue(tabId: string): Promise<QueueDTO> {
		const tab = this.getTab(tabId);
		const session = tab.runtime?.session;
		if (!session) return { steering: [], followUp: [] };
		return session.clearQueue();
	}

	async listSkills(tabId: string): Promise<SkillDTO[]> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		// resourceLoader.getSkills() includes profile skillPaths and
		// extension-discovered dirs; bare loadSkills() would miss them.
		return session.resourceLoader
			.getSkills()
			.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				disableModelInvocation: skill.disableModelInvocation,
			}));
	}

	async listCommands(tabId: string): Promise<CommandDTO[]> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		// Extension commands + prompt templates + skills: exactly what
		// session.prompt() can execute (TUI builtins are interactive-mode only).
		return session.getSlashCommands().map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
		}));
	}

	async listModels(tabId: string): Promise<ModelRefDTO[]> {
		const tab = this.getTab(tabId);
		await this.ensureSession(tabId);
		const session = this.sessionOf(tab);
		const current = modelRef(session.model);
		const snapshot = session.modelRuntime
			.getAvailableSnapshot()
			.map((model) => ({ ref: modelRef(model), current: modelRef(model) === current }));
		// The picker is scoped to the models set on the tab's profile (pi-hub
		// stores bare ids there, provider on the profile). Tabs without a
		// profile, or with none configured, see the full snapshot.
		const scope = this.profiles.profileModels(tab.profileName);
		if (!scope || scope.ids.length === 0) return snapshot;
		const listed = snapshot.filter((entry) => {
			const slash = entry.ref.indexOf("/");
			const provider = slash < 0 ? "" : entry.ref.slice(0, slash);
			const id = slash < 0 ? entry.ref : entry.ref.slice(slash + 1);
			return scope.ids.includes(id) && (!scope.provider || provider === scope.provider);
		});
		// Keep the current selection visible even if it fell out of scope
		// (e.g. the session fell back after the profile model was removed).
		if (current && !listed.some((entry) => entry.current)) listed.unshift({ ref: current, current: true });
		return listed;
	}

	async setModel(tabId: string, modelRefInput: string): Promise<string> {
		const tab = this.getTab(tabId);
		if (!tab.runtime) return "";
		const session = tab.runtime.session;
		if (!modelRefInput) {
			await session.cycleModel("forward");
		} else {
			const slash = modelRefInput.indexOf("/");
			if (slash === -1) throw new Error(`Model must be "provider/modelId", got '${modelRefInput}'.`);
			const provider = modelRefInput.slice(0, slash);
			const modelId = modelRefInput.slice(slash + 1);
			const model = session.modelRuntime.getModel(provider, modelId);
			if (!model) throw new Error(`Unknown model '${modelRefInput}'.`);
			await session.setModel(model);
		}
		this.refreshMeta(tab);
		return modelRef(session.model);
	}

	async setThinkingLevel(tabId: string, level: string): Promise<string[]> {
		const tab = this.getTab(tabId);
		if (!tab.runtime) return [];
		const session = tab.runtime.session;
		await session.setThinkingLevel(level as never);
		this.refreshMeta(tab);
		return session.getAvailableThinkingLevels() as string[];
	}

	/** Tear down a tab's runtime; safe against double-close / double-dispose. */
	private async destroyTab(tab: TabHandle): Promise<void> {
		tab.unsubscribe?.();
		tab.unsubscribe = null;
		const runtime = tab.runtime;
		tab.runtime = null;
		if (runtime) {
			try {
				await runtime.dispose();
			} catch (err) {
				console.warn(`[session-host] error disposing runtime for tab ${tab.tabId}`, err);
			}
		}
	}

	async closeTab(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.tabs.delete(tabId);
		this.dialogs.cancelForTab(tabId);
		await this.destroyTab(tab);
	}

	/**
	 * Switch the tab to a different profile. The runtime is disposed so
	 * the next prompt starts a fresh session under the new agent dir; prior
	 * sessions stay reachable through the history sidebar.
	 */
	async setProfile(tabId: string, profileName: string | null): Promise<void> {
		const tab = this.getTab(tabId);
		await this.destroyTab(tab);
		const { agentDir, error } = this.profiles.resolveAgentDir(profileName);
		this.tabs.set(tabId, {
			...tab,
			profileName,
			agentDir,
			agentDirWarning: error,
			runtime: null,
			unsubscribe: null,
			lastStreaming: false,
			lastMetaJson: "",
		});
	}

	async listSessions(): Promise<SessionListItemDTO[]> {
		// Profile agent dirs symlink the shared sessions dir, so the default
		// listing (source agent dir) sees sessions from every profile.
		const infos = await SessionManager.listAll();
		return infos.map(toSessionListItem);
	}

	/** SDK-backed search over titles and transcript text (SessionManager.search). */
	async searchSessions(query: string): Promise<SessionListItemDTO[]> {
		const infos = await SessionManager.search(query);
		return infos.map(toSessionListItem);
	}

	/**
	 * Delete a session transcript from the history (SDK SessionManager.
	 * deleteSession). Refuses paths that are live in a tab — closing the tab
	 * first keeps the "session file exists while the session object reads it"
	 * invariant intact.
	 */
	async deleteSession(path: string): Promise<boolean> {
		const resolved = resolvePath(path);
		for (const tab of this.tabs.values()) {
			const sessionFile = tab.runtime?.session.sessionFile;
			if (sessionFile && resolvePath(sessionFile) === resolved) {
				throw new Error("This session is open in a tab — close the tab first.");
			}
		}
		return SessionManager.deleteSession(resolved);
	}

	/**
	 * A SettingsManager over the **default profile's** agent dir: that's where
	 * the compaction on/off flag lives (global settings.json, shared with
	 * pipi). Per-tab toggles in the composer menu act on the tab's own dir.
	 */
	private compactionSettings(): SettingsManager {
		const { default: defaultProfile } = this.profiles.list();
		const { agentDir } = this.profiles.resolveAgentDir(defaultProfile ?? null);
		// projectTrusted:false — a settings read must never prompt or load
		// project-scoped files; compaction.enabled is a global key anyway.
		return sdk.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	}

	async getCompactionSettings(): Promise<CompactionSettingsDTO> {
		return {
			enabled: this.compactionSettings().getCompactionEnabled(),
			// Threshold/floor/cap are pi-plus context settings: one file under
			// the source agent dir, read process-wide by every session.
			thresholdPercent: getAutoCompactThresholdPercent(),
			floorTokens: getContextFloorTokens(),
			windowCapTokens: getContextWindowCapTokens() ?? null,
		};
	}

	/** Apply a partial patch and return the full updated snapshot. */
	async setCompactionSettings(patch: CompactionPatch): Promise<CompactionSettingsDTO> {
		if (patch.enabled !== undefined) this.compactionSettings().setCompactionEnabled(patch.enabled);
		if (patch.thresholdPercent !== undefined) setAutoCompactThresholdPercent(patch.thresholdPercent);
		if (patch.floorTokens !== undefined) setContextFloorTokens(patch.floorTokens);
		if (patch.windowCapTokens !== undefined) setContextWindowCapTokens(patch.windowCapTokens ?? undefined);
		return this.getCompactionSettings();
	}

	/** Async runtime disposal — the caller (before-quit) is expected to race
	 *  this with a timeout so a wedged turn can't block the app from closing. */
	async disposeAll(): Promise<void> {
		for (const tab of [...this.tabs.values()]) {
			await this.destroyTab(tab);
		}
		this.tabs.clear();
	}
}
