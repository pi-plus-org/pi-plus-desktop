/**
 * FileTree: the right-hand panel showing the active tab's CWD as a lazy,
 * expandable file tree — the mirror of the left-hand history sidebar.
 * One directory level is fetched at a time through the same fs:listDir IPC
 * as the composer's @-menu (it clamps listings to the tab's cwd, resolves
 * symlinked dirs, and caps huge listings), so no new main-process surface is
 * needed. The header ⟳ re-lists every expanded directory; ⌘/Ctrl+⌥/Alt+B
 * (View → Toggle File Tree) collapses the panel to a floating chip, like the
 * history sidebar's ⌘B. The tree re-syncs when the active tab or its cwd
 * changes (tab switch, /cd, resume) and debounce-refreshes on chat activity
 * so files the agent creates/edited show up.
 */

import type { DirEntryDTO } from "../../shared/ipc-types.ts";
import { notify } from "./dialogs.ts";
import { store } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const FILETREE_MIN = 180;
const FILETREE_MAX = 520;
const FILETREE_DEFAULT = 240;

/** Shared with main.ts, which clamps the persisted width before first paint. */
export function clampFiletreeWidth(px: number): number {
	return Math.min(FILETREE_MAX, Math.max(FILETREE_MIN, Number.isFinite(px) ? px : FILETREE_DEFAULT));
}

export class FileTree {
	private root: HTMLElement;
	private resizer: HTMLElement;
	/** True while no tab is open: the panel is fully hidden (no chip either). */
	private hidden = false;
	/** tabId + cwd of what is currently displayed; change triggers a reload. */
	private lastKey = "";
	/** cwd-relative paths of expanded directories ("" = the cwd root). */
	private expanded = new Set<string>();
	/** Loaded children per directory relPath; "" holds the root listing. */
	private children = new Map<string, DirEntryDTO[]>();
	/** Per-directory "listing was capped" flags. */
	private truncated = new Set<string>();
	private loading = false;
	/** Bumped on every refresh; renders from a stale pass are dropped. */
	private loadSeq = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(root: HTMLElement) {
		this.root = root;
		this.resizer = this.createResizer();
	}

	/** Drag handle on the panel's left edge (the boundary with the chat);
	 *  live-adjusts #app's grid column via the --filetree-w var and persists
	 *  the width on release. */
	private createResizer(): HTMLElement {
		const handle = el("div", "filetree-resizer");
		handle.title = "Drag to resize · double-click for the default width";
		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = this.root.getBoundingClientRect().width;
			handle.setPointerCapture(e.pointerId);
			handle.classList.add("filetree-resizer-active");
			const move = (ev: PointerEvent): void => {
				// The handle sits on the panel's left edge, so dragging left grows it.
				document.documentElement.style.setProperty("--filetree-w", `${clampFiletreeWidth(startWidth + (startX - ev.clientX))}px`);
			};
			const up = (): void => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.classList.remove("filetree-resizer-active");
				const width = this.root.getBoundingClientRect().width;
				void window.pi.setFiletreeWidth(width).catch((err) => console.warn("[filetree] save width failed", err));
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
		});
		handle.addEventListener("dblclick", () => {
			document.documentElement.style.setProperty("--filetree-w", `${FILETREE_DEFAULT}px`);
			void window.pi.setFiletreeWidth(FILETREE_DEFAULT).catch((err) => console.warn("[filetree] save width failed", err));
		});
		return handle;
	}

	toggle(): void {
		if (this.hidden) return; // no open tab — nothing to show
		// toggle() returns true when the class was ADDED — i.e. we collapsed.
		const nowCollapsed = this.root.classList.toggle("filetree-collapsed");
		if (!nowCollapsed) {
			// Un-collapsed: sync() reloads only when the tab/cwd changed, so an
			// unchanged tree still needs an explicit re-render here — otherwise
			// the panel keeps the collapsed chip's DOM and looks empty.
			this.sync();
			this.render();
		} else {
			this.render();
		}
	}

	/** Reload when the active tab (or its cwd) changed; no-op otherwise.
	 *  With no tab open the panel hides entirely (not the folded chip). */
	sync(): void {
		const tab = store.active;
		if (!tab) {
			if (!this.hidden) {
				this.hidden = true;
				this.lastKey = "";
				this.expanded.clear();
				this.children.clear();
				this.truncated.clear();
				// filetree-collapsed reuses the existing :has() grid rules (0-width
				// track); filetree-hidden additionally suppresses the expand chip.
				this.root.classList.add("filetree-hidden", "filetree-collapsed");
				this.render();
			}
			return;
		}
		if (this.hidden) {
			this.hidden = false;
			this.root.classList.remove("filetree-hidden", "filetree-collapsed");
		}
		const key = `${tab.tabId}\n${tab.cwd}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		// relPaths are only valid within one cwd — drop all cached listings.
		this.expanded.clear();
		this.children.clear();
		this.truncated.clear();
		void this.refresh();
	}

	/** Debounced refresh for chat activity (agent edits create/delete files). */
	scheduleRefresh(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 800);
	}

	async refresh(): Promise<void> {
		if (this.hidden) return;
		const tab = store.active;
		if (!tab) {
			this.children.clear();
			this.truncated.clear();
			this.render();
			return;
		}
		const seq = ++this.loadSeq;
		this.loading = true;
		this.render();
		// Re-list the root plus every expanded directory in one pass.
		const dirs = ["", ...this.expanded];
		const results = await Promise.all(
			dirs.map((rel) =>
				window.pi
					.listDir(tab.tabId, rel)
					.then((r) => ({ rel, entries: r.entries.filter((e) => e.name !== ".."), truncated: r.truncated }))
					.catch(() => ({ rel, entries: [] as DirEntryDTO[], truncated: false })),
			),
		);
		if (seq !== this.loadSeq) return; // a newer pass superseded this one
		this.loading = false;
		this.children.clear();
		this.truncated.clear();
		for (const { rel, entries, truncated } of results) {
			this.children.set(rel, entries);
			if (truncated) this.truncated.add(rel);
		}
		this.render();
	}

	private expandDir(rel: string): void {
		this.expanded.add(rel);
		if (this.children.has(rel)) {
			this.render();
			return;
		}
		void this.refresh();
	}

	private collapseDir(rel: string): void {
		this.expanded.delete(rel);
		// Collapsing drops the subtree's cached listings so a stale child dir
		// (deleted/renamed while hidden) cannot resurrect on re-expand.
		for (const key of [...this.children.keys()]) {
			if (key !== "" && (key === rel || key.startsWith(`${rel}/`))) this.children.delete(key);
		}
		for (const key of [...this.truncated]) {
			if (key === rel || key.startsWith(`${rel}/`)) this.truncated.delete(key);
		}
		this.render();
	}

	render(): void {
		this.root.replaceChildren();

		// Hidden (no open tab): render nothing — not even the expand chip.
		if (this.hidden) return;

		// Collapsed: a floating expand chip over the chat's top-right corner.
		if (this.root.classList.contains("filetree-collapsed")) {
			const expand = el("button", "filetree-expand", "«");
			expand.title = "Show files (⌘⌥B)";
			expand.addEventListener("click", () => this.toggle());
			this.root.append(expand);
			return;
		}

		const tab = store.active;
		const header = el("div", "sidebar-header");
		header.append(el("span", "sidebar-header-title", "Files"));
		const openBtn = el("button", "sidebar-refresh", "📂");
		openBtn.title = "Open folder in system file explorer";
		openBtn.addEventListener("click", () => {
			const cwd = store.active?.cwd;
			if (!cwd) return;
			void window.pi.openPath(cwd).then((error) => {
				if (error) notify(`Could not open '${cwd}': ${error}`, "error");
			});
		});
		const refreshBtn = el("button", "sidebar-refresh", "⟳");
		refreshBtn.title = "Refresh file tree";
		refreshBtn.addEventListener("click", () => void this.refresh());
		const collapseBtn = el("button", "sidebar-refresh", "»");
		collapseBtn.title = "Hide files (⌘⌥B)";
		collapseBtn.addEventListener("click", () => this.toggle());
		header.append(openBtn, refreshBtn, collapseBtn);
		this.root.append(header, this.resizer);

		const cwdLabel = el("div", "filetree-cwd");
		cwdLabel.textContent = tab ? tab.cwd || "(no folder)" : "";
		cwdLabel.title = tab?.cwd ?? "";
		this.root.append(cwdLabel);

		if (!tab) {
			this.root.append(el("div", "sidebar-empty", "No active session"));
			return;
		}

		const list = el("div", "sidebar-list filetree-list");
		if (this.loading && this.children.size === 0) {
			list.append(el("div", "sidebar-empty", "Loading…"));
		} else {
			const rootEntries = this.children.get("");
			if (rootEntries && rootEntries.length === 0 && !this.loading) {
				list.append(el("div", "sidebar-empty", "Empty folder"));
			} else if (rootEntries) {
				for (const entry of rootEntries) list.append(this.renderEntry(entry, 0));
				if (this.truncated.has("")) list.append(this.renderTruncated(0));
			} else if (!this.loading) {
				list.append(el("div", "sidebar-empty", "Loading…"));
			}
		}
		this.root.append(list);
	}

	private renderEntry(entry: DirEntryDTO, depth: number): HTMLElement {
		const isOpen = this.expanded.has(entry.relPath);
		const row = el("div", "filetree-row");
		row.style.paddingLeft = `${10 + depth * 14}px`;

		const arrow = el("span", "filetree-arrow", entry.isDir ? (isOpen ? "▾" : "▸") : "");
		row.append(arrow);
		row.append(el("span", entry.isDir ? "filetree-name filetree-dir" : "filetree-name", entry.name));
		row.title = entry.relPath;

		if (entry.isDir) {
			row.classList.add("filetree-row-dir");
			row.addEventListener("click", () => (isOpen ? this.collapseDir(entry.relPath) : this.expandDir(entry.relPath)));
			if (isOpen) {
				const children = this.children.get(entry.relPath);
				const wrap = el("div", "filetree-children");
				wrap.append(row);
				if (children) {
					if (children.length === 0) wrap.append(this.renderPlaceholder("Empty folder", depth + 1));
					for (const child of children) wrap.append(this.renderEntry(child, depth + 1));
					if (this.truncated.has(entry.relPath)) wrap.append(this.renderTruncated(depth + 1));
				} else {
					wrap.append(this.renderPlaceholder("Loading…", depth + 1));
				}
				return wrap;
			}
		}
		return row;
	}

	private renderPlaceholder(text: string, depth: number): HTMLElement {
		const node = el("div", "filetree-row filetree-placeholder", text);
		node.style.paddingLeft = `${24 + depth * 14}px`;
		return node;
	}

	private renderTruncated(depth: number): HTMLElement {
		return this.renderPlaceholder("… more (kept out of the listing)", depth);
	}
}
