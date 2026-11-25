/**
 * Chat view: renders a tab's ChatItem list, plus the live streaming buffer.
 * Appends are incremental; streaming deltas mutate the tail node's text
 * directly so per-token updates never re-render the list.
 */

import { isImagePath } from "../../shared/attachments.ts";
import type { ChatMessageDTO, ContentBlockDTO } from "../../shared/ipc-types.ts";
import { thumbSrc } from "./image-thumb.ts";
import { renderDiffView, renderAddedFile } from "./diff-view.ts";
import { renderDiagramEmbed } from "./diagram-view.ts";
import { renderMarkdownToHtml, enhanceCodeBlocks, escapeHtml } from "./markdown.ts";
import { notify } from "./dialogs.ts";
import { store, type ChatItem, type TabState, type ToolBlock } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function toolBlockFor(tab: TabState, toolCallId: string): ToolBlock | undefined {
	return tab.tools.get(toolCallId);
}

/**
 * Fold policy for agent tool rows. write/edit rows follow the thinking-block
 * rule (the newest of the current turn unfolds while it streams, everything
 * folds when the turn settles); bash and read rows fold by default. Manual
 * toggles persist per toolCallId (ChatView keeps the override map) so
 * re-renders don't undo a user choice.
 */
interface ToolFold {
	isOpen: (toolCallId: string, name: string) => boolean;
	onToggle: (toolCallId: string, open: boolean) => void;
}

function toolCallStatus(tab: TabState, toolCallId: string): string {
	return toolBlockFor(tab, toolCallId)?.status ?? "running";
}

/** A bash toolResult whose content already lives in its tool-call card
 *  (command + full output when expanded). Rendering the transcript's
 *  standalone result row too would duplicate the card, so renderTab skips
 *  it. The card must actually exist: the matching toolCall block is in the
 *  assistant item, and tab.tools carries the block (live run or rebuilt
 *  transcript) — otherwise the row renders as before. */
export function isCardedBashResult(tab: TabState, item: ChatItem): boolean {
	return (
		item.kind === "toolResult" &&
		item.message.toolName === "bash" &&
		!!item.message.toolCallId &&
		tab.tools.has(item.message.toolCallId)
	);
}

/**
 * Tool-call row: header (icon + name + status) toggle-open. Rows render
 * folded by default (`openByDefault` carries the fold policy's auto-open —
 * only the newest write/edit mid-stream — plus manual opens across
 * re-renders); `onToggle` records manual folds/expands so later re-renders
 * respect them.
 */
function renderToolRow(
	tab: TabState,
	toolCallId: string,
	fallbackName: string,
	openByDefault = false,
	onToggle?: (toolCallId: string, open: boolean) => void
): HTMLElement {
	const tool = toolBlockFor(tab, toolCallId);
	const name = tool?.name ?? fallbackName;
	const status = tool?.status ?? "running";
	const row = el("div", `tool-row tool-${status}`);
	if (openByDefault) row.classList.add("tool-open");
	const header = el("div", "tool-header");
	header.append(el("span", "tool-icon", status === "running" ? "▸" : status === "error" ? "✗" : "✓"));
	header.append(el("span", "tool-name", name));
	header.append(el("span", "tool-status", status === "running" ? "running…" : status));
	row.append(header);
	// The row folds by default; the header is the toggle. A chevron in the
	// header advertises the fold state — without it a folded row just looks
	// like a one-line summary with no affordance.
	let hint: HTMLElement | null = null;
	const wireToggle = () => {
		header.classList.add("tool-toggle");
		hint = el("span", "tool-fold-hint", row.classList.contains("tool-open") ? "▾" : "▸");
		header.append(hint);
		header.addEventListener("click", () => {
			const open = row.classList.toggle("tool-open");
			if (hint) hint.textContent = open ? "▾" : "▸";
			onToggle?.(toolCallId, open);
		});
	};

	const body = el("div", "tool-body");
	const args = tool?.argsPreview ?? "";
	if (args) body.append(el("pre", "tool-pre tool-args", args));
	if (tool?.resultPreview) body.append(el("pre", "tool-pre tool-result", tool.resultPreview));
	if (body.childElementCount > 0) {
		wireToggle();
		row.append(body);
	}
	return row;
}

function renderUserItem(item: Extract<ChatItem, { kind: "user" }>): HTMLElement {
	const row = el("div", "msg msg-user");
	const bubble = el("div", "msg-user-bubble");
	bubble.textContent = item.text;
	if (item.queued && item.queued.state !== "delivered") {
		// Optimistic steer/follow-up echo: dimmed + tagged until the SDK
		// delivers it (state flips to "delivered" -> plain bubble at its
		// transcript slot) or discards it (abort/clear -> "not delivered").
		const state = item.queued.state;
		const label = item.queued.mode === "steer" ? "steering" : "follow-up";
		row.classList.add(state === "dropped" ? "msg-dropped" : "msg-queued");
		const tag = el(
			"span",
			"msg-queued-tag",
			state === "pending"
				? `sending · ${label}`
				: state === "queued"
					? `queued · ${label}`
					: "not delivered",
		);
		// Say honestly *when* each mode gets its turn: steering is injected at
		// the next turn boundary (which can be far away behind a long tool
		// loop), a follow-up only runs once the agent would otherwise stop —
		// an endless tool loop never stops, so it may wait the whole run.
		if (state === "pending") {
			// The main process still owns this send: it retries while the session is
			// busy (auto-compaction refuses prompts mid-compact), so the queue not
			// holding it yet means nothing worse than "still in flight".
			tag.title = `Waiting for the session to accept this ${label} message (retried while it is busy)`;
		} else if (state === "queued") {
			tag.title =
				item.queued.mode === "steer"
					? "Waiting for the next turn boundary to interrupt the run"
					: "Waiting for the agent to stop before running (a long tool loop can delay this a lot)";
		} else {
			tag.title = "The run ended or the queue was cleared before this was delivered";
		}
		bubble.append(tag);
	}
	row.append(bubble);
	if (item.attachments && item.attachments.length > 0) {
		const chipRow = el("div", "msg-user-attachments");
		for (const path of item.attachments) {
			const name = path.split(/[/\\]/).pop() || path;
			if (isImagePath(path)) {
				const img = document.createElement("img");
				img.className = "msg-user-image";
				img.title = path;
				void thumbSrc(path).then((src) => {
					if (src) img.src = src;
					else {
						const chip = el("span", "attachment-chip");
						chip.title = path;
						chip.append("📎 ");
						const chipName = el("span", "attachment-chip-name", name);
						chip.append(chipName);
						chipRow.replaceChild(chip, img); // unreadable -> plain chip
					}
				});
				chipRow.append(img);
			} else {
				const chip = el("span", "attachment-chip");
				chip.title = path;
				chip.append("📎 ");
				chip.append(el("span", "attachment-chip-name", name));
				chipRow.append(chip);
			}
		}
		row.append(chipRow);
	}
	return row;
}

function renderNoticeItem(text: string): HTMLElement {
	return el("div", "msg msg-notice", text);
}

function renderCompactionItem(text: string): HTMLElement {
	return el("div", "msg msg-compaction", text);
}

/**
 * Composer "!" bash block: a terminal-style card — command header, streamed
 * output body, status footer. macOS/Linux run through the SDK's shell
 * (bash/zsh); Windows through cmd.exe — the executor owns that choice.
 */
function renderBashItem(
	tab: TabState,
	item: Extract<ChatItem, { kind: "bash" }>
): HTMLElement {
	const block = el("div", `bash-block${item.running ? " bash-running" : ""}`);

	const header = el("div", "bash-header");
	header.append(el("span", "bash-prompt", item.excludeFromContext ? "!!" : "!"));
	header.append(el("span", "bash-command", item.command));
	if (item.excludeFromContext) {
		header.append(el("span", "bash-flag", "· not in context"));
	}
	if (item.running) {
		header.append(el("span", "bash-hint", "running…"));
		const stop = el("button", "bash-stop", "✕") as HTMLButtonElement;
		stop.title = "Cancel this command";
		stop.addEventListener("click", () => {
			stop.disabled = true;
			void window.pi.abortBash(tab.tabId).catch(() => {
				/* abort of a finished command is a no-op */
			});
		});
		header.append(stop);
	}
	block.append(header);

	if (item.output) {
		const pre = el("pre", "bash-output");
		pre.textContent = item.output;
		// Streamed output stays pinned to the tail while the command runs. The
		// node is rebuilt per chunk, so scroll after insertion (layout exists only then).
		if (item.running) requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
		block.append(pre);
	}

	if (item.running) {
		block.append(el("div", "bash-footer", "“!” — shell command; Esc or ✕ to cancel"));
	} else if (item.error) {
		block.append(el("div", "bash-footer bash-error", item.error));
	} else {
		const parts: string[] = [];
		if (item.cancelled) parts.push("cancelled");
		else parts.push(item.exitCode === 0 ? "exit 0" : `exit ${item.exitCode ?? "?"}`);
		if (item.truncated) parts.push(`truncated${item.fullOutputPath ? ` — full output: ${item.fullOutputPath}` : ""}`);
		const footer = el("div", `bash-footer${item.exitCode === 0 && !item.cancelled ? "" : " bash-error"}`);
		footer.textContent = parts.join(" · ");
		block.append(footer);
	}
	return block;
}

// Per-message token/cost display lives in the composer status strip (see
// Composer.renderUsage) — the chat stays clean of usage noise.

function assistantContent(message: ChatMessageDTO): ContentBlockDTO[] {
	return typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
}

/** Index of the last thinking block in a content array, or -1. */
function lastThinkingIndex(blocks: ContentBlockDTO[]): number {
	for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]?.type === "thinking") return i;
	return -1;
}

/**
 * The "Blocks" toggle hides ALL agent work — thinking blocks and every tool
 * card / tool result (bash, read, edit, write, task, memory, MCP…). Text,
 * user-visible rows (user messages, notices, composer-run bash) stay on
 * screen so the transcript still reads as a conversation.
 */

/** Row shown in place of hidden work blocks while a turn is streaming. */
function renderRunningIndicator(): HTMLElement {
	const row = el("div", "chat-running");
	row.append(el("span", "chat-running-spinner"), el("span", "chat-running-label", "Running…"));
	return row;
}

/** Last open state each thinking <details> was rendered with. The `toggle`
 * event fires for programmatic `details.open = …` assignments too, so the
 * listener compares against this to tell a real user gesture apart. */
const thinkingRenderedOpen = new WeakMap<HTMLDetailsElement, boolean>();

/** The tab's single expandable thinking block: its text, the open flag the
 * user last set on it (with `touched` marking that a human, not the default,
 * set it), whether a settled turn already folded it, and the DOM node
 * currently rendering it. */
interface ThinkingSlot {
	text: string;
	open: boolean;
	touched: boolean;
	settled: boolean;
	node: HTMLDetailsElement | null;
}

/** Where/how to render the tab's latest thinking block (open by default),
 * plus the handoff hooks the rendered <details> uses to take the slot over. */
interface LatestThinking {
	index: number;
	open: boolean;
	/** Claim the slot for this node, folding whatever node held it before. */
	claim: (node: HTMLDetailsElement) => void;
	/** Record a user toggle — ignored unless `node` still owns the slot. */
	toggle: (node: HTMLDetailsElement, open: boolean) => void;
}

function renderAssistantBlocks(
	tab: TabState,
	content: ContentBlockDTO[],
	container: HTMLElement,
	thinking?: LatestThinking,
	toolFold?: ToolFold
): void {
	for (const [i, block] of content.entries()) {
		// The Blocks toggle strips thinking and every tool card from the
		// transcript; text and everything else still renders.
		if (!tab.showBlocks) {
			if (block.type === "thinking" || block.type === "toolCall") continue;
		}
		switch (block.type) {
			case "text": {
				const node = el("div", "md");
				node.innerHTML = renderMarkdownToHtml(block.text);
				enhanceCodeBlocks(node);
				container.append(node);
				break;
			}
			case "thinking": {
				const details = el("details", "thinking") as HTMLDetailsElement;
				const summary = el("summary", "thinking-summary", "Thinking");
				details.append(summary);
				details.append(el("div", "thinking-body", block.thinking));
				if (thinking && i === thinking.index) {
					details.open = thinking.open;
					thinkingRenderedOpen.set(details, thinking.open);
					thinking.claim(details);
					details.addEventListener("toggle", () => {
						// Programmatic `details.open = …` also fires `toggle`; only a
						// state that differs from the last render is a user gesture.
						if (thinkingRenderedOpen.get(details) === details.open) return;
						thinkingRenderedOpen.set(details, details.open);
						thinking.toggle(details, details.open);
					});
				}
				container.append(details);
				break;
			}
			case "toolCall": {
				const status = toolCallStatus(tab, block.id);
				// A finished draw_diagram renders as a figure inline in the response,
				// not as a tool card; while it runs the plain tool row shows instead.
				const tool = toolBlockFor(tab, block.id);
				if (tool?.diagram && status !== "error") {
					container.append(renderDiagramEmbed(tool.diagram));
					break;
				}
				container.append(
					renderToolRow(tab, block.id, block.name, toolFold ? toolFold.isOpen(block.id, block.name) : false, toolFold?.onToggle)
				);
				break;
			}
			case "image":
				container.append(el("div", "msg-image-placeholder", "[image]"));
				break;
		}
	}
}

function renderAssistantItem(
	tab: TabState,
	message: ChatMessageDTO,
	thinking?: LatestThinking,
	toolFold?: ToolFold
): HTMLElement {
	const row = el("div", "msg msg-assistant");
	const body = el("div", "msg-assistant-body");
	renderAssistantBlocks(tab, assistantContent(message), body, thinking, toolFold);
	row.append(body);
	if (message.errorMessage) row.append(el("div", "msg-error", message.errorMessage));
	return row;
}

/**
 * Recover the full arguments of a tool call by id: assistant items carry the
 * complete (untruncated) toolCall argument objects across IPC, and the live
 * stream tail may still hold the block. Used for diff headers/write content.
 */
function findToolCallArgs(tab: TabState, toolCallId: string): Record<string, unknown> | undefined {
	if (!toolCallId) return undefined;
	const scan = (blocks: ContentBlockDTO[]): Record<string, unknown> | undefined => {
		for (const block of blocks) {
			if (block.type === "toolCall" && block.id === toolCallId) {
				return typeof block.arguments === "object" && block.arguments !== null ? (block.arguments as Record<string, unknown>) : undefined;
			}
		}
		return undefined;
	};
	for (let i = tab.items.length - 1; i >= 0; i--) {
		const item = tab.items[i];
		if (item?.kind !== "assistant") continue;
		const found = scan(assistantContent(item.message));
		if (found) return found;
	}
	return scan([...tab.streamBlocks.values()]);
}

function renderToolResultItem(tab: TabState, message: ChatMessageDTO): HTMLElement {
	const row = el("div", "msg msg-toolresult");
	const name = message.toolName ?? "tool result";
	const args = findToolCallArgs(tab, message.toolCallId ?? "");
	const path = typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
	// Colorful diff instead of the raw JSON/text preview for edit/write.
	if (!message.isError && name === "edit" && message.diff) {
		row.append(el("div", "toolresult-label", `✎ edit${path ? ` ${path}` : ""}`));
		row.append(renderDiffView(message.diff));
		return row;
	}
	if (!message.isError && name === "write" && typeof args?.content === "string" && args.content.trim() !== "") {
		row.append(el("div", "toolresult-label", `✚ write${path ? ` ${path}` : ""}`));
		row.append(renderAddedFile(args.content));
		return row;
	}
	// Resumed draw_diagram transcript without the assistant toolCall alongside:
	// same inline figure as the live path.
	if (!message.isError && message.diagram) {
		row.append(renderDiagramEmbed(message.diagram));
		return row;
	}
	const label = el("div", "toolresult-label", `${message.isError ? "✗" : "✓"} ${name}`);
	row.append(label);
	const text = typeof message.content === "string" ? message.content : message.content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n");
	if (text.trim()) row.append(el("pre", "tool-pre", text));
	return row;
}

export class ChatView {
	private containers = new Map<string, HTMLElement>();
	private root: HTMLElement;
	/** Node holding the live streaming content for fast delta updates. */
	private streamNode: HTMLElement | null = null;
	/**
	 * Per-tab state of the one expandable thinking block. The stream re-renders on
	 * every delta and refreshTools re-renders the whole list, so the block is
	 * identified by its text: deltas grow the same string (prefix match) and
	 * finalization hands it over to the items pass unchanged, while a new
	 * thinking block never prefix-matches and so takes the slot over. The default
	 * open state follows the turn: unfolded while streaming (live reasoning),
	 * folded once the response settles — and kept folded when the next turn
	 * starts streaming (`settled`), so only a new thinking block reopens the
	 * default. A manual toggle (`touched`) pins the block to the user's choice
	 * instead. The node reference is what makes
	 * folding reliable: the message list is only rebuilt on `chat`/`status`
	 * events, so when a new block takes the slot from one that is still on screen
	 * (the previous turn's thinking sitting in a finalized item), the loser is
	 * folded explicitly instead of waiting for a re-render that only comes when
	 * the incoming message finalizes.
	 */
	private thinkingSlots = new Map<string, ThinkingSlot>();
	/** Per-tab manual open/close overrides for agent bash tool rows, keyed by
	 *  toolCallId — survives the full re-renders that chat events trigger. */
	private toolFoldOverrides = new Map<string, Map<string, boolean>>();

	/** Fold policy handed to assistant renders. Bash/read rows stay folded
	 *  always (running or not, streaming or settled) — only a manual toggle
	 *  opens them. write/edit rows follow the thinking block: the newest of
	 *  the current turn unfolds while it streams (including while the call
	 *  runs) and folds when the turn settles. */
	private toolFoldFor(tab: TabState, lastWriteEditToolCallId: string | null): ToolFold {
		return {
			isOpen: (toolCallId, name) => {
				const override = this.toolFoldOverrides.get(tab.tabId)?.get(toolCallId);
				if (override !== undefined) return override;
				if (!tab.streaming) return false;
				if (name !== "write" && name !== "edit") return false;
				return toolCallId === lastWriteEditToolCallId;
			},
			onToggle: (toolCallId, open) => {
				let overrides = this.toolFoldOverrides.get(tab.tabId);
				if (!overrides) this.toolFoldOverrides.set(tab.tabId, (overrides = new Map()));
				overrides.set(toolCallId, open);
			}
		};
	}
	/** The tab whose container currently owns the shared #chat scroll offset. */
	private shownTabId?: string;
	/**
	 * Per-tab pane scroll offset parked when leaving a tab. All tab containers
	 * share the single scrolling #chat pane, so its scrollTop always belongs to
	 * the *leaving* tab's content height: without this memory, switching back
	 * lands at the other tab's offset, which sits in the middle of a taller
	 * transcript. `stick` records that the tab was at its bottom when parked,
	 * so re-entering follows new content instead of restoring a stale offset.
	 */
	private scrollMemory = new Map<string, { top: number; stick: boolean }>();
	/**
	 * Pinned "jump to end" bubble, floated over the bottom-right corner of the
	 * scroll pane (first child of #chat, sticky-bottom) while the active tab is
	 * scrolled up. Clicking it parks the tab at its transcript end.
	 */
	private jumpEndBtn: HTMLButtonElement;

	constructor(root: HTMLElement) {
		this.root = root;
		// Markdown links in chat messages open in a NEW tab of the OS default
		// browser: the window itself must never navigate away (sandbox + CSP
		// 'self' would silently swallow the click anyway), so intercept the
		// click on the delegated root and hand the href to the main process.
		root.addEventListener("click", (e) => {
			const mouse = e as MouseEvent;
			if (mouse.defaultPrevented || mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return;
			const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
			if (!anchor || !this.root.contains(anchor)) return;
			const url = anchor.href;
			if (!/^https?:/i.test(url)) return;
			e.preventDefault();
			void window.pi.openExternal(url).then((error) => {
				if (error) notify(`Could not open '${url}': ${error}`, "error");
			});
		});
		// The jump-to-end bubble must ride above the scrolling content. It is a
		// sticky-bottom element, and that pattern only pins while the element's
		// natural flow slot sits below the viewport — so it must stay the LAST
		// child of #chat (containerFor re-appends it after each new container).
		this.jumpEndBtn = el("button", "chat-jump-end") as HTMLButtonElement;
		this.jumpEndBtn.type = "button";
		this.jumpEndBtn.title = "Jump to end of messages";
		// Inline chevron beats the "↓" glyph: fixed stroke weight, crisp at
		// small sizes, and it inherits the button's text color.
		this.jumpEndBtn.innerHTML =
			'<svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8.2M4 7.5 8 11.5l4-4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		this.jumpEndBtn.addEventListener("click", () => {
			const tab = store.active;
			if (tab) this.scrollToEnd(tab, true);
			this.updateJumpEnd();
		});
		root.append(this.jumpEndBtn);
		// Manual wheel/scrollbar moves change the distance-to-end without any
		// render running, so visibility also follows the pane's own scroll.
		root.addEventListener("scroll", () => this.updateJumpEnd(), { passive: true });
		this.updateJumpEnd();
	}

	/** Show the jump-to-end bubble only while the active tab is scrolled up. */
	private updateJumpEnd(): void {
		const pane = this.root;
		const farFromEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight >= 120;
		this.jumpEndBtn.hidden = !store.active || !farFromEnd;
	}

	containerFor(tab: TabState): HTMLElement {
		let node = this.containers.get(tab.tabId);
		if (!node) {
			node = el("div", "chat-container");
			node.dataset.tabId = tab.tabId;
			this.containers.set(tab.tabId, node);
			this.root.append(node);
			// Keep the sticky jump-to-end bubble the last child of the pane.
			this.root.append(this.jumpEndBtn);
		}
		return node;
	}

	/**
	 * Full re-render of one tab's message list. `forceScroll` jumps to the
	 * transcript end regardless of position — used when the user just sent a
	 * prompt; every other change only *follows* new content when the reader is
	 * already near the bottom, so someone reading mid-history is never yanked.
	 */
	renderTab(tab: TabState, forceScroll = false): void {
		const node = this.containerFor(tab);
		// "Near bottom" must be measured BEFORE the rebuild: the rebuild grows
		// scrollHeight, so a post-hoc check would misread a bottom-pinned reader
		// as scrolled-up whenever a single event adds more than the threshold.
		const stick = this.nearEnd(node.parentElement);
		node.replaceChildren();
		this.streamNode = null;
		// The stream tail owns the latest-thinking slot when it is thinking;
		// otherwise it belongs to the last finalized thinking block — but only
		// while that block is still the newest exchange: once the next user message
		// is on screen the previous block is history, so the slot goes empty (and
		// folds) instead of reopening it for the whole incoming turn.
		let openOn: { item: number; thinking: LatestThinking } | undefined;
		if (![...tab.streamBlocks.values()].some((b) => b.type === "thinking")) {
			for (let i = tab.items.length - 1; i >= 0; i--) {
				const item = tab.items[i];
				if (item?.kind === "user") break;
				if (item?.kind !== "assistant") continue;
				const content = assistantContent(item.message);
				const index = lastThinkingIndex(content);
				if (index >= 0) {
					openOn = { item: i, thinking: this.resolveThinking(tab.tabId, content, index, tab.streaming) };
					break;
				}
			}
			if (!openOn) this.releaseSlot(tab.tabId);
		}
		// Prune manual tool-fold overrides whose tool calls left the transcript.
		const lastWriteEditId = this.lastWriteEditToolCallId(tab);
		const toolOverrides = this.toolFoldOverrides.get(tab.tabId);
		if (toolOverrides && toolOverrides.size > 0) {
			const live = new Set<string>();
			for (const item of tab.items) {
				if (item.kind !== "assistant") continue;
				for (const b of assistantContent(item.message)) {
					if (b.type === "toolCall") live.add(b.id);
				}
			}
			for (const id of [...toolOverrides.keys()]) {
				if (!live.has(id)) toolOverrides.delete(id);
			}
		}
		for (const [i, item] of tab.items.entries()) {
			// A bash toolResult's content renders inside its tool-call card;
			// a separate row below it would just repeat the output.
			if (isCardedBashResult(tab, item)) continue;
			const row = this.renderItem(
				tab,
				item,
				i,
				lastWriteEditId,
				openOn && openOn.item === i ? openOn.thinking : undefined
			);
			// Addressable row index for the in-session message search
			// (message-search.ts): every transcript row carries its own index, so the
			// search never has to assume anything about the pane's child order.
			row.dataset.chatIndex = String(i);
			node.append(row);
		}
		this.renderStream(tab);
		this.scrollToEnd(tab, forceScroll, stick);
	}

	/** Decide the open state for the block at `index` and build its descriptor. */
	private resolveThinking(tabId: string, blocks: ContentBlockDTO[], index: number, streaming: boolean): LatestThinking {
		const block = blocks[index];
		const text = block?.type === "thinking" ? block.thinking : "";
		const slot = this.thinkingSlots.get(tabId) ?? { text: "", open: true, touched: false, settled: false, node: null };
		if (!text.startsWith(slot.text)) {
			// A new block took over: back to the streaming default.
			slot.text = "";
			slot.open = true;
			slot.touched = false;
			slot.settled = false;
		}
		slot.text = text;
		this.thinkingSlots.set(tabId, slot);
		// Default: unfolded while the turn streams (live reasoning), folded once
		// the response settles. `settled` keeps it folded when the NEXT turn
		// starts streaming — only a new thinking block reopens the default. A
		// manual toggle always wins over the default.
		if (!streaming && !slot.touched) slot.settled = true;
		const open = slot.touched ? slot.open : streaming && !slot.settled;
		return {
			index,
			open,
			claim: (node) => {
				const prev = slot.node;
				if (prev && prev !== node && prev.isConnected) prev.open = false;
				slot.node = node;
			},
			toggle: (node, next) => {
				// Only the node currently holding the slot may steer its state.
				if (slot.node === node) {
					slot.open = next;
					slot.touched = true;
				}
			}
		};
	}

	/** Give up the slot: the tab has no current latest thinking block, so fold. */
	private releaseSlot(tabId: string): void {
		const slot = this.thinkingSlots.get(tabId);
		if (!slot) return;
		if (slot.node?.isConnected) slot.node.open = false;
		this.thinkingSlots.delete(tabId);
	}

	private renderItem(
		tab: TabState,
		item: TabState["items"][number],
		index: number,
		lastWriteEditToolCallId: string | null,
		thinking?: LatestThinking
	): HTMLElement {
		switch (item.kind) {
			case "user":
				return renderUserItem(item);
			case "assistant":
				return renderAssistantItem(tab, item.message, thinking, this.toolFoldFor(tab, lastWriteEditToolCallId));
			case "toolResult":
				// Carded tools already show their result inside the expandable tool
				// row — store.ts seeds that card from the transcript (rebuildToolBlocks)
				// and upgrades it with the full result text on message_end, so a
				// standalone result row here would just duplicate the card's body.
				// Orphan results (no matching toolCall in the transcript) still render.
				if (item.message.toolCallId && toolBlockFor(tab, item.message.toolCallId)) {
					return el("div", "msg-toolresult-suppressed");
				}
				// Hidden work blocks: every tool result row goes away with the
				// tool cards (read/edit/write contents, task updates, MCP output…).
				if (!tab.showBlocks) {
					return el("div", "msg-toolresult-suppressed");
				}
				return renderToolResultItem(tab, item.message);
			case "bash":
				return renderBashItem(tab, item);
			case "compaction":
				return renderCompactionItem(item.text);
			case "notice":
				return renderNoticeItem(item.text);
		}
	}

	/** Refresh tool rows only (status/result updates). */
	/** The newest write/edit toolCall of the current turn (after the last user
	 *  message) — the live stream tail counts too. Only this row auto-opens
	 *  while the turn streams (mirroring the thinking slot); scanning stops at
	 *  the last user item so a settled turn's write/edit rows never reopen. */
	private lastWriteEditToolCallId(tab: TabState): string | null {
		const tail = [...tab.streamBlocks.entries()].sort((a, b) => b[0] - a[0]);
		for (const [, block] of tail) {
			if (block.type === "toolCall" && (block.name === "write" || block.name === "edit")) return block.id;
		}
		for (let i = tab.items.length - 1; i >= 0; i--) {
			const item = tab.items[i];
			if (item?.kind === "user") break;
			if (item?.kind !== "assistant") continue;
			const blocks = assistantContent(item.message);
			for (let j = blocks.length - 1; j >= 0; j--) {
				const b = blocks[j];
				if (b?.type === "toolCall" && (b.name === "write" || b.name === "edit")) return b.id;
			}
		}
		return null;
	}

	refreshTools(tab: TabState, forceScroll = false): void {
		// Tool status changes are infrequent; a full re-render keeps the code path
		// simple and preserves streaming node identity.
		this.renderTab(tab, forceScroll);
	}

	/** Update (or create) the live streaming tail. */
	renderStream(tab: TabState): void {
		const node = this.containerFor(tab);
		// Same pre-mutation "at bottom" measurement as renderTab.
		const stick = this.nearEnd(node.parentElement);
		// With work blocks hidden the tail still needs a home while the turn
		// runs (the "Running…" indicator), even before any block arrives.
		const indicatorOnly = !tab.showBlocks && tab.streaming;
		if (this.streamNode?.parentElement === node && tab.streamBlocks.size === 0 && !indicatorOnly) {
			this.streamNode.remove();
			this.streamNode = null;
			this.updateJumpEnd();
			return;
		}
		if (tab.streamBlocks.size === 0 && !indicatorOnly) return;

		if (!this.streamNode || this.streamNode.parentElement !== node) {
			if (this.streamNode) this.streamNode.remove();
			this.streamNode = el("div", "msg msg-assistant msg-streaming");
			node.append(this.streamNode);
		}
		// The live tail is the row *after* the last finalized item.
		this.streamNode.dataset.chatIndex = String(tab.items.length);
		const body = el("div", "msg-assistant-body");
		const blocks = [...tab.streamBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
		// Hidden blocks still occupy indexes, so the visible set may be empty
		// even mid-thought — that empty tail is exactly the spinner moment.
		const visibleCount = tab.showBlocks
			? blocks.length
			: blocks.filter((b) => b.type !== "thinking" && b.type !== "toolCall").length;
		if (visibleCount === 0) {
			body.append(renderRunningIndicator());
		} else {
			const thinkingIndex = lastThinkingIndex(blocks);
			renderAssistantBlocks(
				tab,
				blocks,
				body,
				thinkingIndex >= 0 ? this.resolveThinking(tab.tabId, blocks, thinkingIndex, tab.streaming) : undefined,
				this.toolFoldFor(tab, this.lastWriteEditToolCallId(tab))
			);
		}
		this.streamNode.replaceChildren(body);
		this.scrollToEnd(tab, false, stick);
		this.updateJumpEnd();
	}

	removeTab(tabId: string): void {
		this.containers.get(tabId)?.remove();
		this.containers.delete(tabId);
		this.thinkingSlots.delete(tabId);
		this.toolFoldOverrides.delete(tabId);
		this.scrollMemory.delete(tabId);
		if (this.shownTabId === tabId) this.shownTabId = undefined;
		if (this.streamNode && !this.streamNode.isConnected) this.streamNode = null;
		this.updateJumpEnd();
	}

	showTab(tabId: string): void {
		const pane = this.root;
		const switched = this.shownTabId !== tabId;
		// Park the leaving tab's scroll offset *before* the visibility flip
		// changes the layout (the hidden container stops contributing height).
		if (switched && this.shownTabId && this.containers.has(this.shownTabId)) {
			const stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
			this.scrollMemory.set(this.shownTabId, { top: pane.scrollTop, stick });
		}
		this.shownTabId = tabId;
		for (const [id, node] of this.containers) {
			node.classList.toggle("chat-hidden", id !== tabId);
		}
		if (!switched) {
			this.updateJumpEnd();
			return; // re-showing the same tab must not disturb its scroll
		}
		const tab = store.tabs.get(tabId);
		if (!tab) {
			this.updateJumpEnd();
			return;
		}
		const saved = this.scrollMemory.get(tabId);
		if (saved && !saved.stick) {
			// The user was reading mid-transcript: put them back there (the
			// bubble may need to appear for the restored mid-history position).
			pane.scrollTop = saved.top;
		} else {
			// First visit or bottom-pinned: end of this tab's own history, never
			// the offset inherited from the other tab's content height.
			this.scrollToEnd(tab, true);
		}
		this.updateJumpEnd();
	}

	/** Distance-to-end check against the shared pane. Callers that are about
	 *  to mutate the DOM pass a value measured BEFORE the mutation (the check
	 *  itself reads the grown scrollHeight afterwards). */
	private nearEnd(pane: HTMLElement | null): boolean {
		if (!pane) return true;
		return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
	}

	private scrollToEnd(tab: TabState, force = true, wasNearBottom?: boolean): void {
		if (store.activeTabId !== tab.tabId) return;
		const node = this.containers.get(tab.tabId);
		if (!node) return;
		const pane = node.parentElement;
		if (!pane) return;
		const nearBottom = wasNearBottom ?? this.nearEnd(pane);
		if (force || nearBottom) pane.scrollTop = pane.scrollHeight;
		this.updateJumpEnd();
	}
}

export function emptyStateHtml(text: string): string {
	return `<div class="empty-state">${escapeHtml(text)}</div>`;
}
