/**
 * Sidebar: session history from the SDK (SessionManager.listAll / search),
 * flat and ordered by last activity, newest first. Live sessions show a
 * working (streaming) dot; the active tab's session row is highlighted.
 * The search box runs the SDK's content search (titles + transcript text).
 * Header buttons: ⟳ reload (⌘/Ctrl+R via the menu) and ⟨/⟩ collapse
 * (⌘/Ctrl+B); the right edge drags to resize. Click resumes (or activates the
 * open tab); transcripts are not deletable from the UI.
 */

import type { SessionListItemDTO } from "../../shared/ipc-types.ts";
import { store } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const delta = Date.now() - then;
	const minutes = Math.floor(delta / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 260;

/** Shared with main.ts, which clamps the persisted width before first paint. */
export function clampSidebarWidth(px: number): number {
	return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number.isFinite(px) ? px : SIDEBAR_DEFAULT));
}

export class Sidebar {
	private root: HTMLElement;
	private searchInput: HTMLInputElement;
	private resizer: HTMLElement;
	private query = "";
	private searchTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private onResume: (item: SessionListItemDTO) => void;

	constructor(root: HTMLElement, onResume: (item: SessionListItemDTO) => void) {
		this.root = root;
		this.onResume = onResume;
		this.searchInput = el("input", "sidebar-search") as HTMLInputElement;
		this.searchInput.type = "search";
		this.searchInput.placeholder = "Search titles & content…";
		this.searchInput.addEventListener("input", () => {
			this.query = this.searchInput.value;
			this.scheduleSearch();
		});
		this.resizer = this.createResizer();
	}

	/** Drag handle on the panel's right edge; live-adjusts #app's grid column
	 *  via the --sidebar-w var and persists the width on release. */
	private createResizer(): HTMLElement {
		const handle = el("div", "sidebar-resizer");
		handle.title = "Drag to resize · double-click for the default width";
		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = this.root.getBoundingClientRect().width;
			handle.setPointerCapture(e.pointerId);
			handle.classList.add("sidebar-resizer-active");
			const move = (ev: PointerEvent): void => {
				document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(startWidth + ev.clientX - startX)}px`);
			};
			const up = (): void => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.classList.remove("sidebar-resizer-active");
				const width = this.root.getBoundingClientRect().width;
				void window.pi.setSidebarWidth(width).catch((err) => console.warn("[sidebar] save width failed", err));
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
		});
		handle.addEventListener("dblclick", () => {
			document.documentElement.style.setProperty("--sidebar-w", `${SIDEBAR_DEFAULT}px`);
			void window.pi.setSidebarWidth(SIDEBAR_DEFAULT).catch((err) => console.warn("[sidebar] save width failed", err));
		});
		return handle;
	}

	/** Debounced refresh triggered by session events. */
	scheduleRefresh(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 800);
	}

	/** Snappier debounce for typing in the search box. */
	private scheduleSearch(): void {
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = setTimeout(() => {
			this.searchTimer = null;
			void this.refresh();
		}, 250);
	}

	toggle(): void {
		this.root.classList.toggle("sidebar-collapsed");
		// Collapsed state swaps the whole DOM (rail vs full panel) via render().
		this.render();
	}

	async refresh(): Promise<void> {
		try {
			// Content search runs in the SDK (listAll has no transcript text in the DTO).
			store.history = this.query.trim() ? await window.pi.searchSessions(this.query) : await window.pi.listSessions();
		} catch (err) {
			console.warn("[sidebar] failed to list sessions", err);
			return;
		}
		this.render();
	}

	render(): void {
		this.root.replaceChildren();

		// Collapsed: a thin rail with just the expand affordance.
		if (this.root.classList.contains("sidebar-collapsed")) {
			const expand = el("button", "sidebar-expand", "»");
			expand.title = "Show history (⌘B)";
			expand.addEventListener("click", () => this.toggle());
			this.root.append(expand);
			return;
		}

		const header = el("div", "sidebar-header");
		header.append(el("span", "sidebar-header-title", "History"));
		const refreshBtn = el("button", "sidebar-refresh", "⟳");
		refreshBtn.title = "Reload history (⌘R)";
		refreshBtn.addEventListener("click", () => void this.refresh());
		const collapseBtn = el("button", "sidebar-refresh", "«");
		collapseBtn.title = "Hide history (⌘B)";
		collapseBtn.addEventListener("click", () => this.toggle());
		header.append(refreshBtn, collapseBtn);

		this.root.append(header, this.searchInput, this.resizer);

		if (store.history.length === 0) {
			this.root.append(el("div", "sidebar-empty", this.query.trim() ? "No matches" : "No sessions yet"));
			return;
		}

		const list = el("div", "sidebar-list");
		for (const item of store.history) list.append(this.renderItem(item));
		this.root.append(list);
	}

	private renderItem(item: SessionListItemDTO): HTMLElement {
		const row = el("div", "sidebar-item");
		const liveTabId = store.liveSessions.get(item.id);
		if (liveTabId === store.activeTabId) row.classList.add("sidebar-item-active");
		if (liveTabId) {
			const tab = store.tabs.get(liveTabId);
			const dot = el("span", tab?.streaming ? "sidebar-dot sidebar-dot-working" : "sidebar-dot");
			dot.title = tab?.streaming ? "Working…" : "Open in a tab";
			row.append(dot);
		}

		const body = el("div", "sidebar-item-body");
		const title = item.name || item.firstMessage || "(empty session)";
		body.append(el("div", "sidebar-item-title", title.replace(/\s+/g, " ").trim()));
		const meta = el(
			"div",
			"sidebar-item-meta",
			`${relativeTime(item.modified)} · ${item.messageCount} msg`,
		);
		body.append(meta);
		row.append(body);

		row.title = `${item.cwd}\n${new Date(item.modified).toLocaleString()}`;
		row.addEventListener("click", () => this.onResume(item));
		return row;
	}
}
