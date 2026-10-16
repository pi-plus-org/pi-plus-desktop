/**
 * Renderer state: one TabState per tab, an event reducer applying sanitized
 * session events, and a tiny pub/sub so UI modules re-render only what changed.
 */

import { parseComposedPrompt } from "../../shared/attachments.ts";
import type {
	ChatMessageDTO,
	ContentBlockDTO,
	EnsureResult,
	PermissionMode,
	PromptResultDTO,
	QueueDTO,
	SanitizedEvent,
	SessionListItemDTO,
	SessionMetaDTO,
	TabDescriptor,
	TaskDTO,
	UpdateDTO,
} from "../../shared/ipc-types.ts";

export interface ToolBlock {
	toolCallId: string;
	name: string;
	argsPreview: string;
	status: "running" | "done" | "error";
	resultPreview?: string;
}

/**
 *  Transcript item. `queued` is set when the message was echoed while the
 *  agent was streaming, i.e. it went into the steering/follow-up queue
 *  instead of starting a turn: "pending" = the main process has not confirmed it
 *  reached the session yet (a send racing auto-compaction is retried there, so
 *  this can last seconds — nothing may conclude it was lost), "queued" = the
 *  session holds it in the SDK queue, "delivered" = the agent consumed it (the
 *  echo is reordered to its true transcript slot at that moment), "dropped" =
 *  the queue was discarded (abort) before delivery. `matchKey` is the text the
 *  queue and delivery events carry: slash commands are *expanded* before
 *  queueing, so it differs from the raw `text` the user typed. `echoId` lets the
 *  send promise address this row after a reorder.
 */
export type ChatItem =
	| {
			kind: "user";
			text: string;
			ts?: number;
			attachments?: string[];
			echoId?: number;
			queued?: {
				mode: "steer" | "followUp";
				state: "pending" | "queued" | "delivered" | "dropped";
				matchKey?: string;
			};
	  }
	| { kind: "assistant"; message: ChatMessageDTO }
	| { kind: "toolResult"; message: ChatMessageDTO }
	| { kind: "compaction"; text: string }
	| { kind: "notice"; text: string };

export interface TabState {
	tabId: string;
	cwd: string;
	profileName: string | null;
	ready: boolean;
	streaming: boolean;
	compacting: boolean;
	/** Latest main-pushed session snapshot (model, usage, persisted...). */
	meta?: SessionMetaDTO;
	/** Queued messages while a turn is streaming. */
	queue: QueueDTO;
	/** Pending "undelivered" sweep after a queue_update (see scheduleDropCheck). */
	dropTimer?: ReturnType<typeof setTimeout>;
	/** Pinned todo glance: the tab session's task list (pushed on change). */
	tasks: TaskDTO[];
	// Convenience mirrors of meta fields (kept in sync by setTabMeta).
	sessionId?: string;
	sessionName?: string;
	model: string;
	thinkingLevel: string;
	/** Tool-permission mode (set on create, mirrored from meta; the composer
	 *  dropdown writes it optimistically via setPermissionMode). */
	permissionMode: PermissionMode;
	items: ChatItem[];
	tools: Map<string, ToolBlock>;
	/** Live blocks of the in-flight assistant message, by content index. */
	streamBlocks: Map<number, ContentBlockDTO>;
	streamingToolCalls: Map<number, string>; // contentIndex -> toolCallId
	/** Per-tab composer state: draft text + pending attachment paths. */
	draft: string;
	draftAttachments: string[];
	/** Subset of draftAttachments picked as folders (drives the 📁 chip). */
	draftFolders: string[];
}

export type StoreEvent =
	| { type: "tabs" } // tab list or labels changed
	| { type: "active" }
	| { type: "chat"; tabId: string } // items changed
	| { type: "stream"; tabId: string } // streaming buffer changed
	| { type: "status"; tabId: string } // streaming flag changed
	| { type: "meta"; tabId: string } // meta/queue/compacting changed
	| { type: "tasks"; tabId: string } // task list changed
	| { type: "history" }; // sidebar refresh

type Listener = (event: StoreEvent) => void;

/** "12345" -> "12.3k", "1234567" -> "1.23M". */
export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

function textOfContent(content: ChatMessageDTO["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return "";
				case "image":
					return "[image]";
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join("\n");
}

export function messageToItems(message: ChatMessageDTO): ChatItem[] {
	if (message.role === "user") {
		// Reverse the composer's attachment decoration so resumed sessions show
		// chips/preview instead of the raw path block.
		const { text, attachments } = parseComposedPrompt(textOfContent(message.content));
		return [{ kind: "user", text, ts: message.timestamp, ...(attachments.length > 0 ? { attachments } : {}) }];
	}
	if (message.role === "assistant") return [{ kind: "assistant", message }];
	if (message.role === "toolResult") return [{ kind: "toolResult", message }];
	if (message.role === "custom" && message.display !== false) {
		return [{ kind: "notice", text: typeof message.content === "string" ? message.content : textOfContent(message.content) }];
	}
	return [];
}

class Store {
	private echoSeq = 0;

	tabs = new Map<string, TabState>();
	order: string[] = [];
	activeTabId = "";
	history: SessionListItemDTO[] = [];
	/** sessionId -> tabId for live sessions, to flag working ones in the sidebar. */
	liveSessions = new Map<string, string>();

	private listeners = new Set<Listener>();

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(event: StoreEvent): void {
		for (const fn of this.listeners) fn(event);
	}

	get active(): TabState | undefined {
		return this.tabs.get(this.activeTabId);
	}

	addTab(desc: TabDescriptor): TabState {
		const state: TabState = {
			tabId: desc.tabId,
			cwd: desc.cwd,
			profileName: desc.profileName,
			ready: false,
			streaming: false,
			compacting: false,
			queue: { steering: [], followUp: [] },
			tasks: [],
			model: "",
			thinkingLevel: "",
			permissionMode: desc.permissionMode,
			items: [],
			tools: new Map(),
			streamBlocks: new Map(),
			streamingToolCalls: new Map(),
			draft: "",
			draftAttachments: [],
			draftFolders: [],
		};
		this.tabs.set(desc.tabId, state);
		this.order.push(desc.tabId);
		this.setActive(desc.tabId);
		this.emit({ type: "tabs" });
		return state;
	}

	removeTab(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		if (tab.sessionId) this.liveSessions.delete(tab.sessionId);
		this.tabs.delete(tabId);
		this.order = this.order.filter((id) => id !== tabId);
		if (this.activeTabId === tabId) {
			this.activeTabId = this.order[this.order.length - 1] ?? "";
		}
		this.emit({ type: "tabs" });
		this.emit({ type: "active" });
	}

	setActive(tabId: string): void {
		if (this.activeTabId === tabId) return;
		this.activeTabId = tabId;
		this.emit({ type: "active" });
	}

	applyEnsure(tab: TabState, result: EnsureResult): void {
		tab.ready = true;
		this.setTabMeta(tab, result.meta);
		// Resume may have restored a different profile (transcript-model
		// inference) — sync the tab badge.
		if (result.profileName !== undefined) tab.profileName = result.profileName;
		for (const message of result.messages) {
			tab.items.push(...messageToItems(message));
		}
		if (result.modelFallbackMessage) {
			tab.items.push({ kind: "notice", text: result.modelFallbackMessage });
		}
		this.emit({ type: "meta", tabId: tab.tabId });
		this.emit({ type: "chat", tabId: tab.tabId });
	}

	/** A main-pushed session:meta update (no message repaint). */
	applyMeta(tabId: string, meta: SessionMetaDTO): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.setTabMeta(tab, meta);
		this.emit({ type: "meta", tabId });
		this.emit({ type: "history" }); // name/persisted changes affect the sidebar
	}

	/** A main-pushed session:tasks update for the pinned todo glance. */
	applyTasks(tabId: string, tasks: TaskDTO[]): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		tab.tasks = tasks;
		this.emit({ type: "tasks", tabId });
	}

	/** Full repaint after a session replacement (clone/fork/cd/rewind). */
	replaceSnapshot(tabId: string, result: EnsureResult): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.setTabMeta(tab, result.meta);
		tab.items = [];
		tab.tools.clear();
		tab.streamBlocks.clear();
		tab.streamingToolCalls.clear();
		tab.compacting = false;
		for (const message of result.messages) {
			tab.items.push(...messageToItems(message));
		}
		if (result.modelFallbackMessage) {
			tab.items.push({ kind: "notice", text: result.modelFallbackMessage });
		}
		this.emit({ type: "meta", tabId });
		this.emit({ type: "chat", tabId });
		this.emit({ type: "tabs" }); // label may derive from the first message
		this.emit({ type: "history" });
	}

	private setTabMeta(tab: TabState, meta: SessionMetaDTO): void {
		if (tab.sessionId && tab.sessionId !== meta.sessionId) this.liveSessions.delete(tab.sessionId);
		this.liveSessions.set(meta.sessionId, tab.tabId);
		tab.meta = meta;
		tab.sessionId = meta.sessionId;
		tab.sessionName = meta.sessionName;
		tab.model = meta.model;
		tab.thinkingLevel = meta.thinkingLevel;
		tab.cwd = meta.cwd;
		tab.permissionMode = meta.permissionMode;
	}

	/** Optimistic permission-mode update after window.pi.setPermissionMode. */
	applyPermissionMode(tabId: string, mode: PermissionMode): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.permissionMode === mode) return;
		tab.permissionMode = mode;
		this.emit({ type: "meta", tabId });
	}

	/** Optimistic echo of the user's sent message (the SDK emits no event for it).
	 *  Returns the transcript index plus the `echoId` used to reconcile the row
	 *  once the main process reports what it did with the send — indexes shift
	 *  when deliveries reorder the transcript, echo ids do not. */
	appendUserItem(tabId: string, text: string, attachments?: string[], queueMode?: "steer" | "followUp"): { index: number; echoId: number } {
		const tab = this.tabs.get(tabId);
		if (!tab) return { index: -1, echoId: -1 };
		const echoId = ++this.echoSeq;
		tab.items.push({
			kind: "user",
			text,
			ts: Date.now(),
			...(attachments && attachments.length > 0 ? { attachments } : {}),
			echoId,
			...(queueMode ? { queued: { mode: queueMode, state: "pending" as const } } : {}),
		});
		this.emit({ type: "chat", tabId });
		this.emit({ type: "tabs" }); // label comes from the first user message
		return { index: tab.items.length - 1, echoId };
	}

	/**
	 *  Reconcile an echo with the main process' report (`session-host.prompt()`).
	 *  While it was "pending" nothing was allowed to call it lost: a send racing
	 *  auto-compaction sits in the host's retry loop for seconds and the SDK queue
	 *  legitimately does not hold it yet. Now that the session has it, enrol the
	 *  echo in queue reconciliation under the text the *queue* carries (slash
	 *  commands arrive expanded, unlike the raw bubble), or retire it as a plain
	 *  message when it never entered a queue at all (it started a run, or an
	 *  extension command handled it). "unknown" (or no result at all: the send
	 *  stalled in the host) means the session deferred it and nothing is known
	 *  beyond "not lost" — enrol it on the raw text and let the queue events settle
	 *  it, the pre-existing reconciliation.
	 */
	resolveEcho(tabId: string, echoId: number, result?: PromptResultDTO): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const item = tab.items.find((i) => i.kind === "user" && i.echoId === echoId);
		if (item?.kind !== "user" || !item.queued || item.queued.state !== "pending") return;
		if (result && result.disposition !== "queued" && result.disposition !== "unknown") {
			item.queued.state = "delivered";
		} else {
			item.queued.state = "queued";
			if (result?.queuedText) item.queued.matchKey = result.queuedText;
			// The snapshot may predate this enqueue (the queue_update event and the
			// IPC reply are different channels): re-check shortly so a send that
			// really never made it cannot rot as "queued".
			this.scheduleDropCheck(tab);
		}
		this.emit({ type: "chat", tabId });
	}

	/** Drop the echo of a send the session rejected. */
	removeEcho(tabId: string, echoId: number): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const index = tab.items.findIndex((i) => i.kind === "user" && i.echoId === echoId);
		if (index >= 0) this.removeItemAt(tabId, index);
	}

	removeItemAt(tabId: string, index: number): void {
		const tab = this.tabs.get(tabId);
		if (!tab || index < 0 || index >= tab.items.length) return;
		tab.items.splice(index, 1);
		this.emit({ type: "chat", tabId });
	}

	applyStatus(tabId: string, isStreaming: boolean): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.streaming === isStreaming) return;
		tab.streaming = isStreaming;
		if (!isStreaming) {
			tab.streamBlocks.clear();
			tab.streamingToolCalls.clear();
		}
		this.emit({ type: "status", tabId });
		this.emit({ type: "history" }); // working indicators live in the sidebar
	}

	applyEvent(tabId: string, event: SanitizedEvent): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		switch (event.type) {
			case "message_start":
				tab.streamBlocks.clear();
				tab.streamingToolCalls.clear();
				this.emit({ type: "stream", tabId });
				break;

			case "message_update":
				this.applyUpdate(tab, event.update);
				this.emit({ type: "stream", tabId });
				break;

			case "message_end": {
				// The SDK echoes user messages back as message_end; the optimistic
				// echo in appendUserItem already shows them, so only assistant and
				// toolResult messages are appended here. A queued echo (steer /
				// follow-up) is promoted to "delivered" and moved to the end of the
				// item list — its true transcript slot, after whatever the agent
				// streamed while the message waited in the queue.
				if (event.message.role !== "user") {
					tab.items.push(...messageToItems(event.message));
				} else {
					this.promoteQueued(tab, event.message);
				}
				this.finalizeStream(tab);
				this.emit({ type: "chat", tabId }); // finalized message must hit the item list
				break;
			}

			case "turn_end":
				break; // message_end already carried the finalized message

			case "tool_execution_start":
				tab.tools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					name: event.toolName,
					argsPreview: event.argsPreview,
					status: "running",
				});
				this.emit({ type: "chat", tabId });
				break;

			case "tool_execution_update": {
				const tool = tab.tools.get(event.toolCallId);
				if (tool) {
					tool.resultPreview = event.partialResultPreview;
					this.emit({ type: "chat", tabId });
				}
				break;
			}

			case "tool_execution_end": {
				const tool = tab.tools.get(event.toolCallId);
				if (tool) {
					tool.status = event.isError ? "error" : "done";
					tool.resultPreview = event.resultPreview;
					this.emit({ type: "chat", tabId });
				}
				break;
			}

			case "compaction_start":
				tab.compacting = true;
				tab.items.push({ kind: "compaction", text: "Compacting context…" });
				this.emit({ type: "chat", tabId });
				this.emit({ type: "meta", tabId });
				break;

			case "compaction_end": {
				tab.compacting = false;
				const tokens =
					typeof event.tokensBefore === "number"
						? ` (${formatTokens(event.tokensBefore)} → ${event.estimatedTokensAfter === undefined ? "?" : `~${formatTokens(event.estimatedTokensAfter)}`} tokens)`
						: "";
				if (event.aborted) {
					tab.items.push({ kind: "notice", text: "Compaction aborted." });
				} else if (event.errorMessage) {
					// The SDK already prefixes "Compaction failed: " on the wire.
					const reason = event.errorMessage.startsWith("Compaction failed: ")
						? event.errorMessage.slice("Compaction failed: ".length)
						: event.errorMessage;
					tab.items.push({ kind: "notice", text: `Compaction failed: ${reason}` });
				} else {
					tab.items.push({ kind: "notice", text: `Context compacted${tokens}.` });
				}
				this.emit({ type: "chat", tabId });
				this.emit({ type: "meta", tabId });
				break;
			}

			case "auto_retry_start":
				tab.items.push({ kind: "notice", text: `Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}` });
				this.emit({ type: "chat", tabId });
				break;

			case "auto_retry_end":
				if (!event.success) {
					tab.items.push({ kind: "notice", text: `Retry failed: ${event.finalError ?? "unknown error"}` });
					this.emit({ type: "chat", tabId });
				}
				break;

			case "session_info_changed":
				tab.sessionName = event.name;
				this.emit({ type: "meta", tabId });
				this.emit({ type: "history" });
				break;

			case "thinking_level_changed":
				tab.thinkingLevel = event.level;
				this.emit({ type: "meta", tabId });
				break;

			case "queue_update":
				tab.queue = { steering: event.steering, followUp: event.followUp };
				// Delivery removes the message from the queue immediately before
				// its user message_end arrives; an abort/clear removes it with
				// nothing following. Let the delivery chain win the race, then
				// mark any still-"queued" echo whose text left the queue as
				// undelivered.
				this.scheduleDropCheck(tab);
				this.emit({ type: "meta", tabId });
				break;

			case "entry_appended":
				// History sidebar refreshes on this signal.
				this.emit({ type: "history" });
				break;

			case "extension_error":
				tab.items.push({ kind: "notice", text: `Extension error: ${event.message}` });
				this.emit({ type: "chat", tabId });
				break;

			case "agent_start":
			case "turn_start":
				break;

			case "agent_end": {
				// A run ending is the last chance to be honest about pending
				// echoes: delivery drains the SDK queue (queue_update) and claims
				// the echo (message_end) before or at this point. Anything still
				// "queued" that the queue arrays don't hold was lost on the way
				// (rejected, swallowed, or a stalled send) — show it as dropped
				// instead of letting the bubble rot. abort() also clears the
				// queues, so a stopped run reconciles here too.
				let stale = false;
				for (const item of tab.items) {
					if (item.kind === "user" && this.echoIsLost(tab, item)) {
						item.queued!.state = "dropped";
						stale = true;
					}
				}
				if (stale) this.emit({ type: "chat", tabId });
				break;
			}

			case "agent_settled":
				break;
		}
	}

	private applyUpdate(tab: TabState, update: UpdateDTO): void {
		switch (update.type) {
			case "text_start":
				tab.streamBlocks.set(update.contentIndex, { type: "text", text: "" });
				break;
			case "text_delta": {
				const block = tab.streamBlocks.get(update.contentIndex);
				if (block?.type === "text") block.text += update.delta;
				else tab.streamBlocks.set(update.contentIndex, { type: "text", text: update.delta });
				break;
			}
			case "text_end":
				tab.streamBlocks.set(update.contentIndex, { type: "text", text: update.content });
				break;
			case "thinking_start":
				tab.streamBlocks.set(update.contentIndex, { type: "thinking", thinking: "" });
				break;
			case "thinking_delta": {
				const block = tab.streamBlocks.get(update.contentIndex);
				if (block?.type === "thinking") block.thinking += update.delta;
				else tab.streamBlocks.set(update.contentIndex, { type: "thinking", thinking: update.delta });
				break;
			}
			case "thinking_end":
				tab.streamBlocks.set(update.contentIndex, { type: "thinking", thinking: update.content });
				break;
			case "toolcall_start":
				tab.streamingToolCalls.set(update.contentIndex, update.toolCall.id);
				tab.streamBlocks.set(update.contentIndex, {
					type: "toolCall",
					id: update.toolCall.id,
					name: update.toolCall.name,
					arguments: update.toolCall.argumentsPreview,
				});
				break;
			case "toolcall_delta":
				break; // arguments preview already captured at toolcall_start
			case "toolcall_end":
				tab.streamingToolCalls.set(update.contentIndex, update.toolCall.id);
				tab.streamBlocks.set(update.contentIndex, {
					type: "toolCall",
					id: update.toolCall.id,
					name: update.toolCall.name,
					arguments: update.toolCall.argumentsPreview,
				});
				break;
			case "done":
			case "error":
				break; // message_end follows with the finalized message
		}
	}

	/**
	 *  Match an SDK-delivered user message to its optimistic queued echo
	 *  (FIFO; exact text first, then composed-prefix when attachments were
	 *  folded into the prompt) and mark it delivered, moving it to the end
	 *  of the item list — the position it actually entered the transcript
	 *  at. Silent no-op for direct prompts, whose untagged echo is already
	 *  last (and for user messages that arrived outside a desktop send).
	 */
	private promoteQueued(tab: TabState, message: ChatMessageDTO): void {
		if (!message || message.role !== "user") return;
		const delivered = textOfContent(message.content);
		if (!delivered) return;
		let match: ChatItem | undefined;
		for (const item of tab.items) {
			if (item.kind !== "user" || item.queued?.state !== "queued" || !item.text) continue;
			// The queue and the delivery carry the expanded text, so match against it
			// when the send went through a slash command; the prefix rule keeps
			// attachment-composed sends claiming their raw echo.
			const key = item.queued.matchKey ?? item.text;
			if (key === delivered) {
				match = item;
				break;
			}
			if (!match && delivered.startsWith(key)) match = item;
		}
		if (!match) {
			// A delivery can outrun the host's reply (event and IPC reply are different
			// channels): claim a still-pending echo, but only on an exact text match so
			// an unrelated prefix can never steal a send that is mid-retry.
			for (const item of tab.items) {
				if (item.kind !== "user" || item.queued?.state !== "pending" || !item.text) continue;
				if (item.text === delivered) {
					match = item;
					break;
				}
			}
		}
		if (!match || match.kind !== "user" || !match.queued) return;
		match.queued.state = "delivered";
		const idx = tab.items.indexOf(match);
		if (idx !== -1 && idx !== tab.items.length - 1) {
			tab.items.splice(idx, 1);
			tab.items.push(match);
		}
	}

	/** See the queue_update case: settle "queued" echoes that no delivery will claim. */
	private scheduleDropCheck(tab: TabState): void {
		if (tab.dropTimer !== undefined) return;
		tab.dropTimer = setTimeout(() => {
			delete tab.dropTimer;
			if (!this.tabs.has(tab.tabId)) return;
			let changed = false;
			for (const item of tab.items) {
				if (item.kind === "user" && this.echoIsLost(tab, item)) {
					item.queued!.state = "dropped";
					changed = true;
				}
			}
			if (changed) this.emit({ type: "chat", tabId: tab.tabId });
		}, 600);
	}

	/** Whether this echo is still pending in either queue array. The queue carries
	 *  the expanded text (`matchKey`) when the send went through a slash command;
	 *  the prefix fallback keeps attachment-composed sends matched. */
	private queueHolds(tab: TabState, item: Extract<ChatItem, { kind: "user" }>): boolean {
		const raw = item.queued?.matchKey ?? item.text;
		const holds = (list: string[]) => list.some((t) => t === raw || t.startsWith(raw));
		return holds(tab.queue.steering) || holds(tab.queue.followUp);
	}

	/** A "queued" echo the latest queue snapshot no longer holds: it was lost
	 *  (abort/clear) rather than delivered. "pending" echoes are never judged
	 *  here - the main process may still be retrying the send. */
	private echoIsLost(tab: TabState, item: Extract<ChatItem, { kind: "user" }>): boolean {
		return item.queued?.state === "queued" && !this.queueHolds(tab, item);
	}

	private finalizeStream(tab: TabState): void {
		tab.streamBlocks.clear();
		tab.streamingToolCalls.clear();
		this.emit({ type: "stream", tabId: tab.tabId });
	}

	/** "<cwd folder name> - <session title>"; title is the session name or the first user message. */
	tabLabel(tab: TabState): string {
		let title = "New session";
		if (tab.sessionName) {
			title = tab.sessionName;
		} else {
			const first = tab.items.find((item) => item.kind === "user");
			if (first && first.kind === "user") {
				const text = first.text.replace(/\s+/g, " ").trim();
				if (text) title = text.length > 32 ? `${text.slice(0, 32)}…` : text;
			}
		}
		const folder = tab.cwd ? tab.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop() : undefined;
		return folder ? `${folder} - ${title}` : title;
	}
}

export const store = new Store();
