/**
 * Chat view: renders a tab's ChatItem list, plus the live streaming buffer.
 * Appends are incremental; streaming deltas mutate the tail node's text
 * directly so per-token updates never re-render the list.
 */

import { isImagePath } from "../../shared/attachments.ts";
import type { ChatMessageDTO, ContentBlockDTO } from "../../shared/ipc-types.ts";
import { thumbSrc } from "./image-thumb.ts";
import { renderDiffView, renderAddedFile } from "./diff-view.ts";
import { renderMarkdownToHtml, escapeHtml } from "./markdown.ts";
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

function renderToolRow(tab: TabState, toolCallId: string, fallbackName: string): HTMLElement {
	const tool = toolBlockFor(tab, toolCallId);
	const name = tool?.name ?? fallbackName;
	const status = tool?.status ?? "running";
	const row = el("div", `tool-row tool-${status}`);
	const header = el("div", "tool-header");
	header.append(el("span", "tool-icon", status === "running" ? "▸" : status === "error" ? "✗" : "✓"));
	header.append(el("span", "tool-name", name));
	header.append(el("span", "tool-status", status === "running" ? "running…" : status));
	row.append(header);

	const body = el("div", "tool-body");
	const args = tool?.argsPreview ?? "";
	if (args) body.append(el("pre", "tool-pre", args));
	if (tool?.resultPreview) body.append(el("pre", "tool-pre tool-result", tool.resultPreview));
	if (body.childElementCount > 0) {
		header.classList.add("tool-toggle");
		header.addEventListener("click", () => row.classList.toggle("tool-open"));
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
		row.classList.add(item.queued.state === "queued" ? "msg-queued" : "msg-dropped");
		const tag = el(
			"span",
			"msg-queued-tag",
			item.queued.state === "queued"
				? `queued · ${item.queued.mode === "steer" ? "steering" : "follow-up"}`
				: "not delivered",
		);
		// Say honestly *when* each mode gets its turn: steering is injected at
		// the next turn boundary (which can be far away behind a long tool
		// loop), a follow-up only runs once the agent would otherwise stop —
		// an endless tool loop never stops, so it may wait the whole run.
		if (item.queued.state === "queued") {
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
						const chip = el("span", "attachment-chip", `📎 ${name}`);
						chip.title = path;
						chipRow.replaceChild(chip, img); // unreadable -> plain chip
					}
				});
				chipRow.append(img);
			} else {
				const chip = el("span", "attachment-chip", `📎 ${name}`);
				chip.title = path;
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

/** The tab's single expanded thinking block: its text, the open flag the user
 * last set on it, and the DOM node currently rendering it. */
interface ThinkingSlot {
	text: string;
	open: boolean;
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

function renderAssistantBlocks(tab: TabState, content: ContentBlockDTO[], container: HTMLElement, thinking?: LatestThinking): void {
	for (const [i, block] of content.entries()) {
		switch (block.type) {
			case "text": {
				const node = el("div", "md");
				node.innerHTML = renderMarkdownToHtml(block.text);
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
					thinking.claim(details);
					details.addEventListener("toggle", () => thinking.toggle(details, details.open));
				}
				container.append(details);
				break;
			}
			case "toolCall": {
				container.append(renderToolRow(tab, block.id, block.name));
				break;
			}
			case "image":
				container.append(el("div", "msg-image-placeholder", "[image]"));
				break;
		}
	}
}

function renderAssistantItem(tab: TabState, message: ChatMessageDTO, thinking?: LatestThinking): HTMLElement {
	const row = el("div", "msg msg-assistant");
	const body = el("div", "msg-assistant-body");
	renderAssistantBlocks(tab, assistantContent(message), body, thinking);
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
	/**
	 * Per-tab state of the one expanded thinking block. The stream re-renders on
	 * every delta and refreshTools re-renders the whole list, so the block is
	 * identified by its text: deltas grow the same string (prefix match) and
	 * finalization hands it over to the items pass unchanged, while a new
	 * thinking block never prefix-matches and so starts expanded again. The node
	 * reference is what makes folding reliable: the message list is only rebuilt
	 * on `chat` events, so when a new block takes the slot from one that is still
	 * on screen (the previous turn's thinking sitting in a finalized item), the
	 * loser is folded explicitly instead of waiting for a re-render that only
	 * comes when the incoming message finalizes.
	 */
	private thinkingSlots = new Map<string, ThinkingSlot>();

	constructor(root: HTMLElement) {
		this.root = root;
	}

	containerFor(tab: TabState): HTMLElement {
		let node = this.containers.get(tab.tabId);
		if (!node) {
			node = el("div", "chat-container");
			node.dataset.tabId = tab.tabId;
			this.containers.set(tab.tabId, node);
			this.root.append(node);
		}
		return node;
	}

	/** Full re-render of one tab's message list. */
	renderTab(tab: TabState): void {
		const node = this.containerFor(tab);
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
					openOn = { item: i, thinking: this.resolveThinking(tab.tabId, content, index) };
					break;
				}
			}
			if (!openOn) this.releaseSlot(tab.tabId);
		}
		for (const [i, item] of tab.items.entries()) {
			node.append(this.renderItem(tab, item, openOn && openOn.item === i ? openOn.thinking : undefined));
		}
		this.renderStream(tab);
		this.scrollToEnd(tab);
	}

	/** Decide the open state for the block at `index` and build its descriptor. */
	private resolveThinking(tabId: string, blocks: ContentBlockDTO[], index: number): LatestThinking {
		const block = blocks[index];
		const text = block?.type === "thinking" ? block.thinking : "";
		const slot = this.thinkingSlots.get(tabId) ?? { text: "", open: true, node: null };
		if (!text.startsWith(slot.text)) {
			// A new block took over: reset it to expanded.
			slot.text = "";
			slot.open = true;
		}
		slot.text = text;
		this.thinkingSlots.set(tabId, slot);
		const open = slot.open;
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
				if (slot.node === node) slot.open = next;
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

	private renderItem(tab: TabState, item: TabState["items"][number], thinking?: LatestThinking): HTMLElement {
		switch (item.kind) {
			case "user":
				return renderUserItem(item);
			case "assistant":
				return renderAssistantItem(tab, item.message, thinking);
			case "toolResult":
				return renderToolResultItem(tab, item.message);
			case "compaction":
				return renderCompactionItem(item.text);
			case "notice":
				return renderNoticeItem(item.text);
		}
	}

	/** Refresh tool rows only (status/result updates). */
	refreshTools(tab: TabState): void {
		// Tool status changes are infrequent; a full re-render keeps the code path
		// simple and preserves streaming node identity.
		this.renderTab(tab);
	}

	/** Update (or create) the live streaming tail. */
	renderStream(tab: TabState): void {
		const node = this.containerFor(tab);
		if (this.streamNode?.parentElement === node && tab.streamBlocks.size === 0) {
			this.streamNode.remove();
			this.streamNode = null;
			return;
		}
		if (tab.streamBlocks.size === 0) return;

		if (!this.streamNode || this.streamNode.parentElement !== node) {
			if (this.streamNode) this.streamNode.remove();
			this.streamNode = el("div", "msg msg-assistant msg-streaming");
			node.append(this.streamNode);
		}
		const body = el("div", "msg-assistant-body");
		const blocks = [...tab.streamBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
		const thinkingIndex = lastThinkingIndex(blocks);
		renderAssistantBlocks(tab, blocks, body, thinkingIndex >= 0 ? this.resolveThinking(tab.tabId, blocks, thinkingIndex) : undefined);
		this.streamNode.replaceChildren(body);
		this.scrollToEnd(tab, false);
	}

	removeTab(tabId: string): void {
		this.containers.get(tabId)?.remove();
		this.containers.delete(tabId);
		this.thinkingSlots.delete(tabId);
		if (this.streamNode && !this.streamNode.isConnected) this.streamNode = null;
	}

	showTab(tabId: string): void {
		for (const [id, node] of this.containers) {
			node.classList.toggle("chat-hidden", id !== tabId);
		}
		const tab = store.tabs.get(tabId);
		if (tab) this.scrollToEnd(tab, false);
	}

	private scrollToEnd(tab: TabState, force = true): void {
		if (store.activeTabId !== tab.tabId) return;
		const node = this.containers.get(tab.tabId);
		if (!node) return;
		const pane = node.parentElement;
		if (!pane) return;
		const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
		if (force || nearBottom) pane.scrollTop = pane.scrollHeight;
	}
}

export function emptyStateHtml(text: string): string {
	return `<div class="empty-state">${escapeHtml(text)}</div>`;
}
