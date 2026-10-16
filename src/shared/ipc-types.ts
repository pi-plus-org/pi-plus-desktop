/**
 * IPC contract shared by main, preload, and renderer.
 *
 * All payloads crossing the IPC boundary are plain JSON-compatible DTOs:
 * Dates are ISO strings, SDK classes are reduced to descriptors, and token
 * secrets never leave the main process (profiles carry `hasToken` instead).
 */

// ---------------------------------------------------------------------------
// Invoke channels (renderer -> main, request/response)
// ---------------------------------------------------------------------------

export interface TabDescriptor {
	tabId: string;
	cwd: string;
	profileName: string | null;
	permissionMode: PermissionMode;
}

/** Tool-call permission mode, mirroring the SDK's pi-plus-permissions modes. */
export type PermissionMode = "bypass" | "acceptEdits" | "auto" | "plan";

/** Content blocks with image payloads replaced by placeholders. */
export type ContentBlockDTO =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: unknown }
	| { type: "image"; placeholder: true };

export interface ChatMessageDTO {
	role: "system" | "user" | "assistant" | "toolResult" | "custom" | "bashExecution";
	content: string | ContentBlockDTO[];
	/** assistant/toolResult/system */
	provider?: string;
	model?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Display diff lifted from the edit tool result's `details.diff`; only set
	 *  on toolResult messages whose tool produced one. */
	diff?: string;
	customType?: string;
	display?: boolean;
	/** bashExecution (composer "!" mode): the command, captured output, and the
	 *  executor's flags. `excludeFromContext` marks "!!" runs (transcript-only). */
	command?: string;
	output?: string;
	exitCode?: number | null;
	cancelled?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	timestamp?: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costTotal: number };
}

/** Estimated context occupancy; tokens/percent are null right after compaction
 *  (unknown until the next LLM response). */
export interface ContextUsageDTO {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Live session state pushed on every change; the renderer's single source of
 *  truth for tab labels, chips, and menu gating. */
export interface SessionMetaDTO {
	cwd: string;
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	/** "provider/modelId"; "" when no model is set. */
	model: string;
	thinkingLevel: string;
	/** Note: the flag is a global setting (per agent dir), not per session. */
	autoCompactionEnabled: boolean;
	contextUsage: ContextUsageDTO | null;
	availableThinkingLevels: string[];
	/** True once the transcript exists on disk — gates clone/fork. */
	persisted: boolean;
	/** Tool-call permission mode of the tab (drives the composer dropdown). */
	permissionMode: PermissionMode;
}

export interface EnsureResult {
	meta: SessionMetaDTO;
	messages: ChatMessageDTO[];
	/** Model notice shown as a chat line at session creation: the SDK's
	 *  fallback report and/or the profile out-of-scope auto-switch. */
	modelFallbackMessage?: string;
	/** Set by fork/rewind results: the chosen user message text for the composer. */
	editorText?: string;
	/** True when an extension vetoed a fork/rewind (no new snapshot). */
	cancelled?: boolean;
	/** Set by ensureSession when resume restored a different profile than the
	 *  tab's current one (transcript-model inference): syncs the tab badge. */
	profileName?: string | null;
}

export interface CompactResultDTO {
	tokensBefore: number;
	/** Estimated post-compaction tokens; absent when not computable. */
	estimatedTokensAfter?: number;
}

/** One skill from the session's resource loader (profile + project dirs). */
export interface SkillDTO {
	name: string;
	description: string;
	disableModelInvocation: boolean;
}

/** One slash command invokable via prompt() (extension command, prompt template, or skill). */
export interface CommandDTO {
	/** Invocation name without the leading "/" (skills appear as "skill:name"). */
	name: string;
	description?: string;
	/** "builtin" entries are desktop-only intercepts (like the pi TUI builtins)
	 *  that never reach session.prompt(). */
	source: "extension" | "prompt" | "skill" | "builtin";
}

/** One model in the picker; current marks the selection. */
export interface ModelRefDTO {
	/** "provider/modelId" */
	ref: string;
	current: boolean;
	/** False when the runtime has no such model (profile id unknown to the
	 *  provider's catalogue) — shown but not selectable, like the pi TUI. */
	available?: boolean;
}

/** One user message offered by the fork/rewind pickers. */
export interface ForkTargetDTO {
	entryId: string;
	/** Truncated preview of the message text. */
	text: string;
}

/** Snapshot of the steering/follow-up queues (from clearQueue / queue_update). */
export interface QueueDTO {
	steering: string[];
	followUp: string[];
}

/** Outcome of a composer "!" bash run (session-host.runBash). Live output is
 *  streamed via bash_execution_update events; this is the final record. */
export interface BashResultDTO {
	command: string;
	/** Captured stdout+stderr (truncated by the executor for huge outputs). */
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

/**
 * What the main process actually did with a `prompt()` send, so the renderer can
 * reconcile the optimistic echo it painted. `session.prompt()` expands slash
 * commands (skills, prompt templates, extension commands) before queueing, and a
 * send that arrives while auto-compaction is running is retried until the run
 * accepts it — in both cases the queue holds text the echo never saw.
 */
export interface PromptResultDTO {
	/** "queued" — pushed onto the steering/follow-up queue and waiting for a turn
	 *  boundary; "started" — it began a run directly (the tab was idle); "handled"
	 *  — an extension command or input handler consumed it without a model turn;
	 *  "unknown" — the session deferred the send (it landed while agent_settled was
	 *  being emitted), so nothing is known beyond "not lost". */
	disposition: "queued" | "started" | "handled" | "unknown";
	/** The expanded text sitting in the queue (only when disposition is "queued"). */
	queuedText?: string;
}

/** One agent task from the pi-plus-tasks store, as pushed for the pinned todo
 *  glance (read-only; description/blocks stay main-side). */
export interface TaskDTO {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
	owner?: string;
	blockedBy: string[];
}

export interface SessionListItemDTO {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

/** pi-plus profile shape (pi-hub `Profile`), with the token masked on read. */
export interface ProfileDTO {
	provider?: string;
	model?: string;
	models?: string[];
	thinking?: string;
	/** True when a token is stored (read path; the secret itself never crosses IPC). */
	hasToken?: boolean;
	/** Sent only when the user typed a new token in the form; "" clears it. */
	token?: string;
	url?: string;
	settings?: Record<string, unknown>;
}

export interface ProfilesDataDTO {
	profiles: Record<string, ProfileDTO>;
	/** Name of the default profile new tabs start under; undefined when unset. */
	default?: string;
}

// ---------------------------------------------------------------------------
// Provider login (AuthInteraction) bridge — see main/auth-bridge.ts
// ---------------------------------------------------------------------------

/** One interactive login prompt bridged to the Settings window. */
export interface AuthPromptDTO {
	requestId: string;
	/** Profile whose login is running; the renderer routes answers/cancels by it. */
	name: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	/** Present only for type "select"; resolve value is the chosen option id. */
	options?: { id: string; label: string; description?: string }[];
}

/** One-way status line for a running login flow (URLs are opened by main). */
export interface AuthNotifyDTO {
	name: string;
	type: "info" | "auth_url" | "device_code" | "progress";
	message: string;
	/** The URL main already opened externally; shown as a clickable fallback. */
	url?: string;
}

/** Non-secret metadata read from <profileDir>/auth.json (never exposes values). */
export interface ProfileAuthStatusDTO {
	providers: { id: string; type: "api_key" | "oauth" }[];
}

/** One configured pi package (SDK ConfiguredPackage, plain JSON). */
export interface PackageDTO {
	source: string;
	scope: "user" | "project";
	/** True when the settings entry is an object form (resources filtered). */
	filtered: boolean;
	installedPath?: string;
}

/** Live progress from install/remove/update operations (SDK ProgressEvent). */
export interface PackageProgressDTO {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

/** Availability of the CLI tools package operations shell out to. */
export interface PackageToolsDTO {
	/** Absolute path to the npm binary, or null when unavailable. */
	npm: string | null;
	/** Absolute path to the git binary, or null when unavailable. */
	git: string | null;
}

// ---------------------------------------------------------------------------
// Push channels (main -> renderer)
// ---------------------------------------------------------------------------

/** Streaming deltas extracted from AssistantMessageEvent (partial dropped). */
export type UpdateDTO =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; toolCall: ToolCallPreviewDTO }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallPreviewDTO }
	| { type: "done"; reason: string; message: ChatMessageDTO }
	| { type: "error"; reason: string; message: ChatMessageDTO };

export interface ToolCallPreviewDTO {
	id: string;
	name: string;
	/** Truncated JSON of the arguments object. */
	argumentsPreview: string;
}

export type SanitizedEvent =
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start" }
	| { type: "message_update"; update: UpdateDTO }
	| { type: "message_end"; message: ChatMessageDTO }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; argsPreview: string }
	| { type: "tool_execution_update"; toolCallId: string; partialResultPreview: string }
	| { type: "tool_execution_end"; toolCallId: string; resultPreview: string; isError: boolean }
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: "compaction_start"; reason: string }
	| {
			type: "compaction_end";
			reason: string;
			aborted: boolean;
			errorMessage?: string;
			/** Token counts from the compaction result, when available. */
			tokensBefore?: number;
			estimatedTokensAfter?: number;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	/** Composer "!" bash mode: streamed stdout/stderr chunk of a running
	 *  command, keyed by the renderer-minted requestId. */
	| { type: "bash_execution_update"; id: string; delta: string }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "entry_appended" }
	| { type: "extension_error"; message: string };

export interface SessionStatusDTO {
	tabId: string;
	isStreaming: boolean;
}

export type DialogKind = "select" | "confirm" | "input" | "editor" | "planReview";

export interface DialogRequestDTO {
	tabId: string;
	requestId: string;
	kind: DialogKind;
	title: string;
	/** select options */
	options?: string[];
	/** confirm message */
	message?: string;
	/** input placeholder / editor prefill */
	placeholder?: string;
	prefill?: string;
	/** planReview: plan markdown body */
	plan?: string;
}

export interface MenuActionDTO {
	action: "new-tab" | "close-active-tab" | "prev-tab" | "next-tab" | "toggle-sidebar" | "toggle-filetree" | "edit-externally" | "reload-history" | "focus-composer";
}

/** One entry of a tab-cwd directory listing (for the composer's @-menu). */
export interface DirEntryDTO {
	name: string;
	/** cwd-relative, forward-slash separated (e.g. "src/main/index.ts"). */
	relPath: string;
	isDir: boolean;
}

export interface ListDirResultDTO {
	entries: DirEntryDTO[];
	/** True when the listing was capped (dirs first, then files, alphabetical). */
	truncated: boolean;
}

/** App-wide theme preference, mirrored by the main-process settings store. */
export type ThemeMode = "system" | "light" | "dark";

/**
 * Location of an install tool (npm/git) the package store shells out to:
 * auto-detect on PATH, or a manually configured binary path.
 */
export interface PackageToolSettingDTO {
	mode: "auto" | "manual";
	/** Manual mode only: path to the tool binary ("" = unset). */
	path: string;
}

/** Per-tool location settings, keyed by tool name. */
export interface PackageToolsSettingsDTO {
	npm: PackageToolSettingDTO;
	git: PackageToolSettingDTO;
}

/**
 * Desktop chrome preferences, stored in the piPlus block of the base agent
 * settings.json (~/.pi/agent/settings.json) via pi-plus-sdk; `editor` is the
 * upstream `externalEditor` key of that same file (shared with pipi's Ctrl+G).
 */
export interface AppSettingsDTO {
	theme: ThemeMode;
	/** External editor command line for the composer (e.g. "code --wait"). */
	editor: string;
	/** History panel width in px (drag-resizable; see renderer Sidebar). */
	sidebarWidth: number;
	/** File tree panel width in px (drag-resizable; see renderer FileTree). */
	filetreeWidth: number;
	/** History panel remembered folded (⟨ chip) across launches. */
	sidebarCollapsed: boolean;
	/** File tree panel remembered folded (« chip) across launches. */
	filetreeCollapsed: boolean;
	/** Permission mode new tabs start with (Settings → Permissions). */
	defaultPermissionMode: PermissionMode;
	/** npm/git install-tool locations (Packages window → Package tools). */
	packageTools: PackageToolsSettingsDTO;
}

/**
 * Compaction settings, all in ~/.pi/agent/settings.json (shared with pipi):
 * `enabled` is the upstream `compaction.enabled` key (reached through the
 * default profile's layered SettingsManager, which routes it to the base
 * file), threshold/floor/cap live in the piPlus block. `windowCapTokens`
 * null = no cap.
 */
export interface CompactionSettingsDTO {
	enabled: boolean;
	thresholdPercent: number;
	floorTokens: number;
	windowCapTokens: number | null;
}

/** One entry of the Settings → Editors picker (command "" = $VISUAL/$EDITOR). */
export interface EditorOptionDTO {
	label: string;
	command: string;
}

/** Partial update for setCompaction; null clears the window cap. */
export interface CompactionPatch {
	enabled?: boolean;
	thresholdPercent?: number;
	floorTokens?: number;
	windowCapTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const IPC = {
	invoke: {
		createTab: "session:createTab",
		ensureSession: "session:ensure",
		prompt: "session:prompt",
		runBash: "session:runBash",
		abortBash: "session:abortBash",
		abort: "session:abort",
		closeTab: "session:closeTab",
		setTabProfile: "session:setTabProfile",
		listSessions: "session:list",
		searchSessions: "session:search",
		deleteSession: "session:delete",
		setModel: "session:setModel",
		setThinkingLevel: "session:setThinkingLevel",
		compact: "session:compact",
		abortCompaction: "session:abortCompaction",
		setAutoCompaction: "session:setAutoCompaction",
		clone: "session:clone",
		cd: "session:cd",
		listForkTargets: "session:listForkTargets",
		forkFromMessage: "session:forkFromMessage",
		rewind: "session:rewind",
		renameSession: "session:rename",
		clearQueue: "session:clearQueue",
		listSkills: "session:listSkills",
		listModels: "session:listModels",
		listCommands: "session:listCommands",
		setPermissionMode: "session:setPermissionMode",
		listProfiles: "profiles:list",
		createProfile: "profiles:create",
		updateProfile: "profiles:update",
		removeProfile: "profiles:remove",
		renameProfile: "profiles:rename",
		setDefaultProfile: "profiles:setDefault",
		setDefaultModel: "profiles:setDefaultModel",
		addModel: "profiles:addModel",
		removeModel: "profiles:removeModel",
		loginProfile: "profiles:login",
		abortLogin: "profiles:loginAbort",
		authStatus: "profiles:authStatus",
		cleanProfileDir: "profiles:cleanDir",
		getSettings: "settings:get",
		setTheme: "settings:setTheme",
		setEditor: "settings:setEditor",
		listEditors: "settings:listEditors",
		setSidebarWidth: "settings:setSidebarWidth",
		setFiletreeWidth: "settings:setFiletreeWidth",
		setSidebarCollapsed: "settings:setSidebarCollapsed",
		setFiletreeCollapsed: "settings:setFiletreeCollapsed",
		setDefaultPermissionMode: "settings:setDefaultPermissionMode",
		setPackageTools: "settings:setPackageTools",
		openInEditor: "editor:open",
		getCompaction: "settings:getCompaction",
		setCompaction: "settings:setCompaction",
		pickDirectory: "dialog:pickDirectory",
		pickFiles: "dialog:pickFiles",
		readImage: "attachment:readImage",
		saveAttachment: "attachment:save",
		listDir: "fs:listDir",
		revealPath: "shell:revealPath",
		openExternal: "shell:openExternal",
		respondDialog: "dialog:respond",
		respondAuthPrompt: "auth:respond",
		packagesList: "packages:list",
		packagesInstall: "packages:install",
		packagesRemove: "packages:remove",
		packagesUpdate: "packages:update",
		packagesTools: "packages:tools",
	},
	push: {
		sessionEvent: "session:event",
		sessionStatus: "session:status",
		sessionMeta: "session:meta",
		sessionTasks: "session:tasks",
		dialogRequest: "dialog:request",
		dialogNotify: "dialog:notify",
		profilesChanged: "profiles:changed",
		menuAction: "menu:action",
		authPrompt: "auth:prompt",
		authPromptCancel: "auth:promptCancel",
		authNotify: "auth:notify",
		packagesProgress: "packages:progress",
		/** A package install/remove/update succeeded; the main window offers to restart open sessions. */
		packagesChanged: "packages:changed",
	},
} as const;

// ---------------------------------------------------------------------------
// Preload API surface (window.pi)
// ---------------------------------------------------------------------------

export interface PiApi {
	createTab(opts: { cwd?: string; profileName?: string | null }): Promise<TabDescriptor>;
	ensureSession(tabId: string, resumePath?: string): Promise<EnsureResult>;
	/** `mode` decides queueing when a turn is already streaming (default followUp). */
	/** Send a prompt; resolves once the main process has handed it to the session
	 *  (after any compaction retry), with the disposition + expanded queued text. */
	prompt(tabId: string, text: string, attachments?: string[], mode?: "steer" | "followUp"): Promise<PromptResultDTO>;
	abort(tabId: string): Promise<void>;
	/** Composer "!" mode: run a shell command on the tab's session (bash on
	 *  macOS/Linux, cmd.exe on Windows). Output streams via the session-event
	 *  channel keyed by `requestId`; resolves with the final result once the
	 *  command exits (the SDK also records it into the transcript). */
	runBash(tabId: string, requestId: string, command: string, excludeFromContext: boolean): Promise<BashResultDTO>;
	/** Cancel the tab's running bash command(s). */
	abortBash(tabId: string): Promise<void>;
	closeTab(tabId: string): Promise<void>;
	/** Switch the tab's profile: disposes the runtime and starts a fresh session
	 *  under the new profile's agent dir; returns that session's snapshot. */
	setTabProfile(tabId: string, profileName: string | null): Promise<EnsureResult>;
	listSessions(): Promise<SessionListItemDTO[]>;
	/** SDK SessionManager.search: name + message text, case-insensitive, newest first. */
	searchSessions(query: string): Promise<SessionListItemDTO[]>;
	/** Delete a session transcript file (SDK SessionManager.deleteSession). Throws if the session is open in a tab. */
	deleteSession(path: string): Promise<boolean>;
	/** "provider/modelId"; empty string cycles to the next available model. Resolves to the new ref. */
	setModel(tabId: string, modelRef: string): Promise<string>;
	setThinkingLevel(tabId: string, level: string): Promise<string[]>;
	/** Manual compaction (waits for the current turn). Throws while compacting. */
	compact(tabId: string, customInstructions?: string): Promise<CompactResultDTO>;
	abortCompaction(tabId: string): Promise<void>;
	/** Global per-agent-dir setting — affects other pi/pi-plus sessions too. */
	setAutoCompaction(tabId: string, enabled: boolean): Promise<boolean>;
	/** In-place clone (new transcript file, same history); returns a fresh snapshot. */
	clone(tabId: string): Promise<EnsureResult>;
	/** Relocate the session to a new project folder (/cd); returns a fresh snapshot. */
	cd(tabId: string, dirPath: string): Promise<EnsureResult>;
	listForkTargets(tabId: string): Promise<ForkTargetDTO[]>;
	/** Fork the transcript up to (not including) a user message; `editorText` is that message. */
	forkFromMessage(tabId: string, entryId: string): Promise<EnsureResult>;
	/** Rewind the active branch to a user message (optionally summarize the dropped part). */
	rewind(tabId: string, entryId: string, summarize: boolean): Promise<EnsureResult>;
	renameSession(tabId: string, name: string): Promise<void>;
	/** Drop queued steering/follow-up messages; resolves to what was cleared. */
	clearQueue(tabId: string): Promise<QueueDTO>;
	listSkills(tabId: string): Promise<SkillDTO[]>;
	/** Slash commands the tab's session can execute (needs ensureSession first). */
	listCommands(tabId: string): Promise<CommandDTO[]>;
	/** Models available to the tab's session (needs ensureSession first). */
	listModels(tabId: string): Promise<ModelRefDTO[]>;
	/** Switch the tab's tool-permission mode; resolves to the applied mode. */
	setPermissionMode(tabId: string, mode: PermissionMode): Promise<PermissionMode>;
	listProfiles(): Promise<ProfilesDataDTO>;
	createProfile(name: string, profile: ProfileDTO): Promise<void>;
	updateProfile(name: string, profile: ProfileDTO): Promise<void>;
	removeProfile(name: string): Promise<void>;
	renameProfile(oldName: string, newName: string): Promise<void>;
	setDefaultProfile(name: string): Promise<void>;
	/** Select a profile's default model; resolves to a human-readable message. */
	setProfileDefaultModel(name: string, model: string): Promise<string>;
	/** Append a model to a profile without selecting it (rejects duplicates and a fourth model). */
	addProfileModel(name: string, model: string): Promise<string>;
	/** Remove a model from a profile; the default promotes to the next remaining model. */
	removeProfileModel(name: string, model: string): Promise<string>;
	/**
	 * Run the SDK's interactive provider login for a profile (OAuth or api-key
	 * setup). `provider` overrides the stored profile's — lets an unsaved form
	 * sign in without persisting the profile; the credential lands in the
	 * profile dir's auth.json either way.
	 */
	loginProfile(name: string, provider?: string): Promise<void>;
	/** Abort a running login flow for a profile (idempotent). */
	abortLogin(name: string): Promise<void>;
	/** Non-secret credential summary from the profile's materialized auth.json. */
	getProfileAuthStatus(name: string): Promise<ProfileAuthStatusDTO>;
	/** Remove a profile's materialized dir when the profile is not (or no longer) stored; no-op otherwise. */
	cleanProfileDir(name: string): Promise<void>;
	getSettings(): Promise<AppSettingsDTO>;
	setTheme(theme: ThemeMode): Promise<void>;
	/** External editor command line for the composer ("" = fall back to $VISUAL/$EDITOR). */
	setEditor(command: string): Promise<void>;
	/** Installed blocking-GUI editors for the Settings picker. */
	listEditors(): Promise<EditorOptionDTO[]>;
	/** Persist the drag-resized history panel width. */
	setSidebarWidth(width: number): Promise<void>;
	/** Persist the drag-resized file tree panel width. */
	setFiletreeWidth(width: number): Promise<void>;
	/** Persist whether the history panel starts folded next launch. */
	setSidebarCollapsed(collapsed: boolean): Promise<void>;
	/** Persist whether the file tree panel starts folded next launch. */
	setFiletreeCollapsed(collapsed: boolean): Promise<void>;
	/** Permission mode new tabs start with (Settings → Permissions). */
	setDefaultPermissionMode(mode: PermissionMode): Promise<void>;
	/** Persist npm/git tool-location settings (partial patch; see AppSettings). */
	setPackageTools(patch: Partial<PackageToolsSettingsDTO>): Promise<void>;
	/**
	 * Open `text` in the configured editor via a temp file and wait for the
	 * process to exit; resolves to the edited content (undefined when the file
	 * was left empty). GUI editors need a blocking flag like `--wait`.
	 */
	openInEditor(text: string): Promise<string | undefined>;
	/** Read the compaction settings (enabled + threshold/floor/cap context settings). */
	getCompactionSettings(): Promise<CompactionSettingsDTO>;
	/** Apply a partial compaction patch; resolves to the full updated snapshot. */
	setCompactionSettings(patch: CompactionPatch): Promise<CompactionSettingsDTO>;
	pickDirectory(): Promise<string | undefined>;
	/** Native multi-file picker for prompt attachments; absolute paths ([] on cancel). */
	pickFiles(): Promise<string[]>;
	/** Base64 data URL for an image attachment preview; undefined when unreadable. */
	readImage(path: string): Promise<string | undefined>;
	/**
	 * Persist dropped/pasted file bytes (a data URL) into the app's media-inbox
	 * dir and resolve to the saved absolute path — clipboard and browser-drag
	 * payloads carry no filesystem path, so they must land on disk before the
	 * path-reference attachment pipeline can use them.
	 */
	saveAttachment(name: string, dataUrl: string): Promise<string>;
	/** Real filesystem path of a File from a drop/paste event ("" when unknown, e.g. browser images). */
	getPathForFile(file: File): string;
	/**
	 * List one directory of the tab's cwd tree ("" = cwd root), keeping names
	 * that start with `prefix` (case-insensitive; dotfiles only when the prefix
	 * starts with "."). Empty on escape/error.
	 */
	listDir(tabId: string, subpath: string, prefix?: string): Promise<ListDirResultDTO>;
	/**
	 * Reveal an absolute path in the system file explorer (Finder / Windows
	 * Explorer select it in its parent folder; xdg-open fallback on Linux).
	 * Resolves to "" on success, or the error message.
	 */
	revealPath(path: string): Promise<string>;
	/**
	 * Open a URL in a NEW tab of the OS default web browser (http/https only).
	 * Resolves to "" on success, or the error message.
	 */
	openExternal(url: string): Promise<string>;
	respondDialog(requestId: string, value: unknown): void;
	/** Answer a bridged login prompt; null rejects it as "Login cancelled". */
	respondAuthPrompt(requestId: string, value: string | null): void;
	onSessionEvent(cb: (msg: { tabId: string; event: SanitizedEvent }) => void): () => void;
	onSessionStatus(cb: (status: SessionStatusDTO) => void): () => void;
	onSessionMeta(cb: (msg: { tabId: string; meta: SessionMetaDTO }) => void): () => void;
	onSessionTasks(cb: (msg: { tabId: string; tasks: TaskDTO[] }) => void): () => void;
	onDialogRequest(cb: (req: DialogRequestDTO) => void): () => void;
	onDialogNotify(cb: (note: { message: string; type?: string }) => void): () => void;
	onProfilesChanged(cb: (data: ProfilesDataDTO) => void): () => void;
	onPackagesProgress(cb: (event: PackageProgressDTO) => void): () => void;
	/** A package install/remove/update succeeded — the main window offers to restart open sessions so the change takes effect. */
	onPackagesChanged(cb: () => void): () => void;
	listPackages(): Promise<PackageDTO[]>;
	/** Availability of the npm/git binaries package ops shell out to. */
	checkPackageTools(): Promise<PackageToolsDTO>;
	/** Resolves to the fresh package list; rejects with the SDK error message. */
	installPackage(source: string): Promise<PackageDTO[]>;
	removePackage(source: string): Promise<PackageDTO[]>;
	/** Omit source to update every configured package. */
	updatePackages(source?: string): Promise<PackageDTO[]>;
	onMenuAction(cb: (action: MenuActionDTO) => void): () => void;
	onAuthPrompt(cb: (prompt: AuthPromptDTO) => void): () => void;
	/** The SDK resolved a prompt out-of-band (e.g. OAuth callback beat manual code). */
	onAuthPromptCancel(cb: (msg: { requestId: string }) => void): () => void;
	onAuthNotify(cb: (note: AuthNotifyDTO) => void): () => void;
}

declare global {
	interface Window {
		pi: PiApi;
	}
}
