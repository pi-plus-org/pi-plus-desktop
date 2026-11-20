/**
 * In-session message search: a floating find bar over the chat pane that walks
 * the *active tab's* transcript (every rendered message plus the live stream
 * tail) with next/prev navigation, browser-find style.
 *
 * Renderer-only by design: the transcript already lives in `store`, so unlike
 * the sidebar's cross-session search (`SessionManager.search`, main-side) this
 * needs no IPC at all.
 *
 * Two levels of highlight, deliberately:
 *  - every row containing a match gets `.msg-search-hit` (soft inset accent),
 *    the row holding the current match gets `.msg-search-active`. This survives
 *    ChatView rebuilds — the decoration is repainted from match indices after
 *    every render — and it also marks hits that are not visible text (a query
 *    inside a folded thinking block still lights up its message).
 *  - the current match's row additionally gets its occurrences wrapped in
 *    `<mark>` (`searchSvg`'s sibling concern), with the one at the active
 *    occurrence carrying `.msg-search-mark-current`. Folded `<details>`
 *    subtrees are skipped: auto-opening a thinking block would break the
 *    "only one thinking block expanded" invariant in chat-view.ts.
 *
 * Rows are addressed by `data-chat-index` (stamped by ChatView.renderTab, one
 * element per `tab.items[i]`, plus `items.length` for the streaming tail) so
 * this never assumes a child ordering.
 */

import type { ChatMessageDTO, ContentBlockDTO } from "../../shared/ipc-types.ts";
import { notify } from "./dialogs.ts";
import { store, type ChatItem, type TabState } from "./store.ts";
import { isCardedBashResult } from "./chat-view.ts";

/** Cap on collected matches so a 5k-message transcript stays responsive while
 *  typing; the counter shows "500+" when hit. */
const MAX_MATCHES = 500;

export interface SearchMatch {
	/** Index into the active tab's `items`, or `items.length` for the stream tail. */
	itemIndex: number;
	/** Which occurrence inside that message this match is (0-based). */
	nth: number;
}

/** The magnifier, in the same line-art family as the composer's paperclip so it
 *  reads as one button set: stroke-only `currentColor` (it inherits the dimmed
 *  → bright hover text colour), a clean lens ring and a detached, diagonally
 *  flush handle that stays crisp at 16px instead of blobbing into the ring. */
export function searchSvg(size = 16): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.innerHTML = '<circle cx="11" cy="11" r="7" /><path d="M20.5 20.5 16.65 16.65" />';
	return svg;
}

function chevronSvg(dir: "up" | "down"): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "12");
	svg.setAttribute("height", "12");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2.5");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.innerHTML = dir === "up" ? '<path d="M18 15l-6-6-6 6" />' : '<path d="M6 9l6 6 6-6" />';
	return svg;
}

function contentToText(content: string | ContentBlockDTO[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") {
			parts.push(block.name);
			// Arguments are what the user actually wants to find (a path, a
			// pattern); stringify best-effort — a throw must not kill the search.
			try {
				parts.push(typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? "") ?? "");
			} catch {
				/* unserializable — skip */
			}
		}
	}
	return parts.join("\n");
}

function messageText(message: ChatMessageDTO): string {
	const parts = [contentToText(message.content)];
	if (message.toolName) parts.push(message.toolName);
	if (message.diff) parts.push(message.diff);
	if (message.errorMessage) parts.push(message.errorMessage);
	if (message.command) parts.push(message.command);
	if (message.output) parts.push(message.output);
	return parts.join("\n");
}

/** Everything the query is matched against for one transcript row.
 *  Carded bash toolResults render no row of their own (their output lives in
 *  the tool-call card), so they contribute no searchable text — a match
 *  there would light up a row that doesn't exist. */
export function searchableText(item: ChatItem, tab?: TabState): string {
	switch (item.kind) {
		case "user":
			return item.attachments?.length ? `${item.text}\n${item.attachments.join("\n")}` : item.text;
		case "assistant":
		case "toolResult":
			if (tab && isCardedBashResult(tab, item)) return "";
			return messageText(item.message);
		case "bash": {
			const parts = [item.command, item.output];
			if (item.error) parts.push(item.error);
			return parts.join("\n");
		}
		default:
			return item.text;
	}
}

function streamSearchable(tab: TabState): string {
	const parts: string[] = [];
	for (const block of tab.streamBlocks.values()) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") parts.push(block.name);
	}
	return parts.join("\n");
}

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export class MessageSearch {
	/** The scrolling chat pane (`#chat`) whose rows get decorated. */
	private readonly pane: HTMLElement;
	private readonly onFocusClose?: () => void;

	private readonly bar: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly counter: HTMLElement;
	private readonly nextBtn: HTMLButtonElement;
	private readonly prevBtn: HTMLButtonElement;

	private visible = false;
	private query = "";
	private tabId = "";
	private matches: SearchMatch[] = [];
	private capped = false;
	/** Index into `matches`; -1 = none selected. */
	private cursor = -1;

	/** Rows currently carrying `.msg-search-hit` (for cleanup). */
	private hitRows: HTMLElement[] = [];
	private activeRow: HTMLElement | null = null;
	/** `<mark>` nodes inserted in `activeRow`, in DOM/occurrence order. */
	private marks: HTMLElement[] = [];

	/** Per-item lower-cased text, keyed by row object and validated by a cheap
	 *  length fingerprint, so a per-token `refresh()` never re-allocates (or
	 *  re-lowercases) an unchanged transcript. */
	private textCache = new WeakMap<ChatItem, { fp: number; text: string }>();
	private pendingFrame = false;

	constructor(pane: HTMLElement, opts?: { onFocusClose?: () => void }) {
		this.pane = pane;
		this.onFocusClose = opts?.onFocusClose;

		const host = pane.parentElement ?? document.body;
		this.bar = el("div", "search-bar search-bar-hidden");

		const icon = el("span", "search-bar-icon");
		icon.append(searchSvg(14));
		this.input = el("input", "search-bar-input") as HTMLInputElement;
		this.input.type = "text";
		this.input.spellcheck = false;
		this.input.placeholder = "Search messages in this session…";
		this.input.title = "Enter / ↓ next match (Shift+Enter / ↑ previous) · Esc close";
		this.counter = el("span", "search-bar-count");

		this.prevBtn = el("button", "search-bar-btn search-bar-prev") as HTMLButtonElement;
		this.prevBtn.type = "button";
		this.prevBtn.title = "Previous match (Shift+Enter · ↑)";
		this.prevBtn.append(chevronSvg("up"));
		this.nextBtn = el("button", "search-bar-btn search-bar-next") as HTMLButtonElement;
		this.nextBtn.type = "button";
		this.nextBtn.title = "Next match (Enter · ↓ · F3)";
		this.nextBtn.append(chevronSvg("down"));

		const closeBtn = el("button", "search-bar-btn search-bar-close") as HTMLButtonElement;
		closeBtn.type = "button";
		closeBtn.title = "Close search (Esc)";
		closeBtn.textContent = "✕";

		this.bar.append(icon, this.input, this.counter, this.prevBtn, this.nextBtn, closeBtn);
		host.append(this.bar);

		this.input.addEventListener("input", () => {
			this.query = this.input.value;
			this.recompute();
			// Select the first hit as soon as the text matches (no scroll yank while
			// typing) — Enter / ▼ then walks from there.
			this.cursor = this.matches.length > 0 ? 0 : -1;
			this.paint({ scroll: false });
		});
		this.input.addEventListener("keydown", (event) => this.onKey(event));
		this.prevBtn.addEventListener("click", () => this.prev());
		this.nextBtn.addEventListener("click", () => this.next());
		closeBtn.addEventListener("click", () => this.close());
		// Escape from anywhere in the window (e.g. after clicking a message)
		// still closes the bar; Enter/arrows only when focus is not in another
		// text field, so the composer keeps its own keys.
		window.addEventListener("keydown", (event) => {
			if (!this.visible) return;
			const target = event.target as HTMLElement | null;
			const inField = target === this.input || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
			if (event.key === "Escape") {
				event.preventDefault();
				this.close();
				return;
			}
			if (inField) return;
			// A focused button (the bar's own arrows, a row's toggle) keeps its
			// Enter/Space activation — only keys we do not steal navigate.
			if (target?.tagName === "BUTTON" || target?.closest?.("button")) {
				if (event.key === "Enter" || event.key === " ") return;
			}
			if (event.key === "F3") {
				event.preventDefault();
				if (event.shiftKey) this.prev();
				else this.next();
				return;
			}
			if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey)) this.prev();
				else this.next();
			}
		});
	}

	get isVisible(): boolean {
		return this.visible;
	}

	get matchCount(): number {
		return this.matches.length;
	}

	/** 1-based position of the selected match, 0 when none. */
	get position(): number {
		return this.cursor + 1;
	}

	get currentQuery(): string {
		return this.query;
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	open(): void {
		if (!store.active) {
			notify("Open a chat tab first — search runs over the current session's transcript.", "info");
			return;
		}
		this.visible = true;
		this.bar.classList.remove("search-bar-hidden");
		this.tabId = store.active.tabId;
		this.recompute();
		if (this.cursor < 0 || this.cursor >= this.matches.length) this.cursor = this.matches.length > 0 ? 0 : -1;
		// Reopening keeps what was typed (and selects it for quick replace).
		this.input.value = this.query;
		this.paint({ scroll: true });
		this.input.focus();
		this.input.select();
	}

	close(): void {
		if (!this.visible) return;
		this.visible = false;
		this.bar.classList.add("search-bar-hidden");
		this.clearDecor();
		this.updateCounter();
		this.input.blur();
		this.onFocusClose?.();
	}

	/** Coalesce repaints across a burst of store events (stream deltas fire per
	 *  token) into one pass per frame. */
	schedule(): void {
		if (!this.visible || this.pendingFrame) return;
		this.pendingFrame = true;
		const run = () => {
			if (!this.pendingFrame) return;
			this.pendingFrame = false;
			if (this.visible) this.refresh();
		};
		requestAnimationFrame(run);
		// A hidden/off-screen window may not produce frames at all (the test
		// harness runs one), so keep a wall-clock fallback.
		setTimeout(run, 50);
	}

	/**
	 * Recompute after a store event / ChatView rebuild. Repainting is required
	 * because `renderTab` replaces every row, which drops the highlight classes
	 * and the marks; the selected match is kept by position (clamped), and a tab
	 * switch restarts at the first hit.
	 */
	refresh(): void {
		if (!this.visible) return;
		const tab = store.active;
		const switched = !tab || tab.tabId !== this.tabId;
		if (tab) this.tabId = tab.tabId;
		this.recompute();
		if (switched) this.cursor = this.matches.length > 0 ? 0 : -1;
		else if (this.cursor >= this.matches.length) this.cursor = this.matches.length - 1;
		this.paint({ scroll: false });
	}

	// ── navigation ─────────────────────────────────────────────────────────

	next(): void {
		if (this.matches.length === 0) return;
		this.cursor = (this.cursor + 1) % this.matches.length;
		this.paint({ scroll: true });
	}

	prev(): void {
		if (this.matches.length === 0) return;
		this.cursor = this.cursor <= 0 ? this.matches.length - 1 : this.cursor - 1;
		this.paint({ scroll: true });
	}

	private onKey(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.close();
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) this.prev();
			else this.next();
		} else if (event.key === "ArrowDown") {
			// Inside the input the caret owns ←/→ only; arrows navigate.
			event.preventDefault();
			this.next();
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			this.prev();
		}
	}

	// ── matching ───────────────────────────────────────────────────────────

	/** Lower-cased searchable text per row (stream tail last), from the cache. */
	private rowTexts(tab: TabState): string[] {
		const texts: string[] = [];
		for (const item of tab.items) {
			const fp = fingerprint(item);
			let hit = this.textCache.get(item);
			if (!hit || hit.fp !== fp) {
				hit = { fp, text: searchableText(item, tab).toLowerCase() };
				this.textCache.set(item, hit);
			}
			texts.push(hit.text);
		}
		texts.push(streamSearchable(tab).toLowerCase());
		return texts;
	}

	private recompute(): void {
		const needle = this.query.toLowerCase();
		this.matches = [];
		this.capped = false;
		const tab = store.active;
		if (!tab || needle.length === 0) return;
		const texts = this.rowTexts(tab);
		for (const [itemIndex, text] of texts.entries()) {
			let from = 0;
			let nth = 0;
			for (;;) {
				const at = text.indexOf(needle, from);
				if (at < 0) break;
				this.matches.push({ itemIndex, nth });
				nth++;
				from = at + needle.length;
				if (this.matches.length >= MAX_MATCHES) {
					this.capped = true;
					return;
				}
			}
		}
	}

	// ── decoration ─────────────────────────────────────────────────────────

	private rowFor(itemIndex: number): HTMLElement | null {
		return this.pane.querySelector<HTMLElement>(`.chat-container:not(.chat-hidden) [data-chat-index="${itemIndex}"]`);
	}

	private clearDecor(): void {
		for (const row of this.hitRows) row.classList.remove("msg-search-hit");
		this.hitRows = [];
		if (this.activeRow) this.activeRow.classList.remove("msg-search-active");
		this.activeRow = null;
		this.unwrapMarks();
	}

	private paint(opts: { scroll: boolean }): void {
		this.clearDecor();
		if (!this.visible || this.query.length === 0) {
			this.updateCounter();
			return;
		}
		const seen = new Set<number>();
		for (const match of this.matches) {
			if (seen.has(match.itemIndex)) continue;
			seen.add(match.itemIndex);
			const row = this.rowFor(match.itemIndex);
			if (!row) continue;
			row.classList.add("msg-search-hit");
			this.hitRows.push(row);
		}
		const current = this.cursor >= 0 ? this.matches[this.cursor] : undefined;
		if (current) {
			const row = this.rowFor(current.itemIndex);
			if (row) {
				row.classList.add("msg-search-active");
				this.activeRow = row;
				this.markRow(row, current.nth);
				if (opts.scroll) row.scrollIntoView({ block: "center" });
			}
		}
		this.updateCounter();
	}

	/** Wrap every occurrence of the query in `row` with `<mark>`, and flag the
	 *  one at occurrence `nth` (falling back to the last mark when the row's
	 *  rendered text has fewer occurrences than the transcript text did — e.g.
	 *  a hit that lives only in a folded thinking block). */
	private markRow(row: HTMLElement, nth: number): void {
		const needle = this.query.toLowerCase();
		if (needle.length === 0) return;
		const nodes: Text[] = [];
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				const parent = (node as Text).parentElement;
				if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
				if (parent.closest("script, style")) return NodeFilter.FILTER_REJECT;
				const details = parent.closest("details");
				if (details && !details.open) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);

		for (const text of nodes) {
			const value = text.nodeValue ?? "";
			const lower = value.toLowerCase();
			let at = lower.indexOf(needle);
			if (at < 0) continue;
			const frag = document.createDocumentFragment();
			let last = 0;
			while (at >= 0) {
				frag.append(document.createTextNode(value.slice(last, at)));
				const mark = el("mark", "msg-search-mark", value.slice(at, at + needle.length));
				frag.append(mark);
				this.marks.push(mark);
				last = at + needle.length;
				at = lower.indexOf(needle, last);
			}
			frag.append(document.createTextNode(value.slice(last)));
			text.replaceWith(frag);
		}
		const active = this.marks[Math.min(nth, this.marks.length - 1)];
		if (active) active.classList.add("msg-search-mark-current");
	}

	private unwrapMarks(): void {
		const parents = new Set<Node | null>();
		for (const mark of this.marks) {
			if (!mark.isConnected) {
				parents.add(null);
				continue;
			}
			parents.add(mark.parentNode);
			mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
		}
		for (const parent of parents) (parent as HTMLElement | null)?.normalize?.();
		this.marks = [];
	}

	private updateCounter(): void {
		if (this.query.length === 0) {
			this.counter.textContent = "";
			this.counter.classList.remove("search-bar-empty");
			this.prevBtn.disabled = true;
			this.nextBtn.disabled = true;
			return;
		}
		const total = this.capped ? `${MAX_MATCHES}+` : String(this.matches.length);
		this.counter.textContent = this.matches.length > 0 ? `${this.position} / ${total}` : `0 / ${total}`;
		this.counter.classList.toggle("search-bar-empty", this.matches.length === 0);
		this.prevBtn.disabled = this.matches.length === 0;
		this.nextBtn.disabled = this.matches.length === 0;
	}
}

/** Cheap content fingerprint: lengths only, no allocation, and it catches the
 *  in-place mutations the store makes (a tool result filling in, bash output
 *  growing, an echo's text being replaced). */
function fingerprint(item: ChatItem): number {
	switch (item.kind) {
		case "user":
			return item.text.length + (item.attachments?.length ?? 0) * 1000003;
		case "assistant":
		case "toolResult":
			return contentLen(item.message.content) + (item.message.errorMessage?.length ?? 0) + (item.message.diff?.length ?? 0) + (item.message.output?.length ?? 0);
		case "bash":
			return item.command.length + item.output.length + (item.error?.length ?? 0);
		default:
			return item.text.length;
	}
}

function contentLen(content: string | ContentBlockDTO[]): number {
	if (typeof content === "string") return content.length;
	let n = 0;
	for (const block of content) {
		if (block.type === "text") n += block.text.length;
		else if (block.type === "thinking") n += block.thinking.length;
		else if (block.type === "toolCall") n += block.name.length + (typeof block.arguments === "string" ? block.arguments.length : 1000003 * countKeys(block.arguments));
	}
	return n;
}

function countKeys(value: unknown): number {
	if (value && typeof value === "object") return Object.keys(value as object).length;
	return value === undefined ? 0 : 1;
}
