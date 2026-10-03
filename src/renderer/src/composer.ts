/**
 * Composer: a fixed 3-line chat box (overflow scrolls inside) whose bottom
 * strip carries the buttons — paperclip file picker with pending-attachment
 * chips, the "⋯" session-actions menu (rename/clone/cd/fork/rewind//init)
 * and the external-editor ✎ on the left, the round Send/Stop button on the
 * right (Enter to send, Shift+Enter newline, Esc stops while streaming).
 * An "@"-triggered file/folder picker menu rooted at the active tab's cwd
 * inserts an inline @path reference *and* adds an attachment chip; a
 * line-initial "/" opens the slash-command menu (extension commands, prompt
 * templates and skills — the session-executable set).
 *
 * A single status strip above the box merges the session capabilities
 * (model and thinking pickers, skills popover, manual compact/abort) with
 * the live state: steer/queue status, the last exchange's token usage and
 * cost, and the context gauge. The chatbox + strip are per-tab: drafts and
 * attachments are parked on the TabState and restored on tab switch.
 */

import { isImagePath } from "../../shared/attachments.ts";
import type { ChatMessageDTO, CommandDTO, DirEntryDTO, ListDirResultDTO, SkillDTO } from "../../shared/ipc-types.ts";
import type { Dialogs } from "./dialogs.ts";
import { thumbSrc } from "./image-thumb.ts";
import { formatTokens, store, type TabState } from "./store.ts";

/** How far back from the caret to look for the "@" trigger. */
const MAX_AT_TOKEN = 256;

function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

/** "provider/model-id" → "model-id" for the toolbar chip (full ref stays in the title). */
function shortModel(ref: string): string {
	const slash = ref.indexOf("/");
	return slash < 0 ? ref : ref.slice(slash + 1);
}

function paperclipSvg(): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48");
	svg.append(path);
	return svg;
}

/** The "@" mention under the caret, if any. */
function findAtToken(value: string, caret: number): { atStart: number; raw: string } | null {
	const start = Math.max(0, caret - MAX_AT_TOKEN);
	for (let i = caret - 1; i >= start; i--) {
		const ch = value[i];
		if (ch === "\n" || ch === "\r") return null;
		if (ch !== "@") continue;
		const before = i === 0 ? "" : value[i - 1];
		// "foo@bar" is an email, not a mention — keep scanning left.
		if (before && !/\s/.test(before)) continue;
		return { atStart: i, raw: value.slice(i + 1, caret) };
	}
	return null;
}

/** A "/" command token at the caret (must start at the beginning of a line). */
function findSlashToken(value: string, caret: number): { slashStart: number; raw: string } | null {
	let i = caret;
	while (i > 0 && !/\s/.test(value[i - 1] ?? "")) i--;
	if (i > 0 && value[i - 1] !== "\n") return null;
	const token = value.slice(i, caret);
	return token.startsWith("/") ? { slashStart: i, raw: token } : null;
}

/** Session capabilities the composer's ⋯ menu exposes; wired to IPC in main.ts. */
export interface TabActions {
	rename(tab: TabState): void;
	clone(tab: TabState): void;
	changeFolder(tab: TabState): void;
	forkMessage(tab: TabState): void;
	rewind(tab: TabState): void;
	createAgentsMd(tab: TabState): void;
}

interface AtState {
	/** Index of the "@" in the textarea value. */
	atStart: number;
	/** Token text up to and including the last "/" — the dir to list ("" = cwd). */
	dir: string;
	/** Token text after the last "/" — prefix filter on entry names. */
	filter: string;
	entries: DirEntryDTO[];
	truncated: boolean;
	loading: boolean;
	active: number;
}

export class Composer {
	private textarea: HTMLTextAreaElement;
	private button: HTMLButtonElement;
	private attachButton: HTMLButtonElement;
	private sessionMenuBtn: HTMLButtonElement;
	private editorBtn: HTMLButtonElement;
	private actions: TabActions | null = null;
	private attachmentsRow: HTMLElement;
	private atMenu: HTMLElement;
	private slashMenu: HTMLElement;
	private attachments: string[] = [];
	/** Folder-ness is only known when picked from the @-menu (drives 📁 chips). */
	private folderPaths = new Set<string>();
	private at: AtState | null = null;
	private atCache = new Map<string, ListDirResultDTO>();
	/** Guards against stale async listings after the token or dir moved on. */
	private atRequest = 0;
	/** Skip one re-evaluation after programmatically inserting an inline path. */
	private suppressAtNext = false;
	/** Active "/" token state (null = menu closed). */
	private slash: { slashStart: number; filter: string; entries: CommandDTO[]; active: number } | null = null;
	/** Commands per tab (fetched lazily; cleared on tab switch — commands are cwd/extension dependent). */
	private slashCache = new Map<string, CommandDTO[]>();
	private slashRequest = 0;
	private lastTabId: string | null = null;
	private onSend: (text: string, attachments: string[], mode?: "steer" | "followUp") => void;
	private dialogs: Dialogs;
	// status strip widgets (built in the constructor / buildToolbar)
	private toolbar: HTMLElement;
	private modelBtn!: HTMLButtonElement;
	private thinkingBtn!: HTMLButtonElement;
	private skillsBtn!: HTMLButtonElement;
	private compactBtn!: HTMLButtonElement;
	private ctxChip!: HTMLElement;
	private ctxGauge!: HTMLElement;
	private ctxFill!: HTMLElement;
	private ctxLabel!: HTMLElement;
	private queueChip!: HTMLButtonElement;
	private queueClearBtn!: HTMLButtonElement;
	private usageChip!: HTMLElement;
	private sendMode: "steer" | "followUp" = "followUp";
	private skillsPopover: HTMLElement | null = null;
	private closeSkillsPopover: (() => void) | null = null;

	constructor(root: HTMLElement, onSend: (text: string, attachments: string[], mode?: "steer" | "followUp") => void, dialogs: Dialogs) {
		this.onSend = onSend;
		this.dialogs = dialogs;
		this.textarea = document.createElement("textarea");
		this.textarea.className = "composer-input";
		this.textarea.placeholder = "Message pi… (Enter to send, Shift+Enter for newline)";
		// Fixed 3-line box; overflow scrolls inside the textarea (no autosize).
		this.textarea.rows = 3;

		this.attachButton = document.createElement("button");
		this.attachButton.className = "composer-attach";
		this.attachButton.title = "Attach files or folders";
		this.attachButton.append(paperclipSvg());

		this.sessionMenuBtn = document.createElement("button");
		this.sessionMenuBtn.className = "composer-attach composer-session-menu";
		this.sessionMenuBtn.textContent = "⋯";
		this.sessionMenuBtn.title = "Session actions";
		this.sessionMenuBtn.addEventListener("click", () => this.openSessionMenu(this.sessionMenuBtn));

		this.editorBtn = document.createElement("button");
		this.editorBtn.className = "composer-attach composer-editor-btn";
		this.editorBtn.textContent = "✎";
		this.editorBtn.title = "Open the draft in the external editor (⌘⌥E · pick it under Settings → Editors)";
		this.editorBtn.addEventListener("click", () => void this.editExternally());

		this.button = document.createElement("button");
		this.button.className = "composer-send";
		this.button.textContent = "Send";

		this.attachmentsRow = document.createElement("div");
		this.attachmentsRow.className = "composer-attachments";
		this.attachmentsRow.hidden = true;

		this.atMenu = document.createElement("div");
		this.atMenu.className = "at-menu";
		this.atMenu.hidden = true;
		// Rows act on click, but the textarea must keep focus/caret.
		this.atMenu.addEventListener("mousedown", (e) => e.preventDefault());

		this.slashMenu = document.createElement("div");
		this.slashMenu.className = "at-menu slash-menu";
		this.slashMenu.hidden = true;
		this.slashMenu.addEventListener("mousedown", (e) => e.preventDefault());

		this.attachButton.addEventListener("click", () => void this.pickFiles());
		this.textarea.addEventListener("keydown", (e) => {
			if (e.isComposing) return;
			if (this.handleSlashKeydown(e)) return;
			if (this.handleAtKeydown(e)) return;
			if (e.key === "Escape" && store.active?.streaming) {
				e.preventDefault();
				void window.pi.abort(store.activeTabId);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.submit();
			}
		});
		this.textarea.addEventListener("input", () => {
			this.updateAtMenu();
			this.updateSlashMenu();
		});
		// Caret moves (click / arrows) do not fire input; the token must follow it.
		this.textarea.addEventListener("click", () => {
			this.updateAtMenu();
			this.updateSlashMenu();
		});
		this.textarea.addEventListener("keyup", (e) => {
			if (e.key.startsWith("Arrow")) {
				this.updateAtMenu();
				this.updateSlashMenu();
			}
		});
		this.button.addEventListener("click", () => {
			if (store.active?.streaming) {
				const tabId = store.activeTabId;
				void window.pi.abort(tabId);
			} else {
				this.submit();
			}
		});

		// One rounded chat box: textarea on top, button strip pinned to its
		// bottom (clip / ⋯ / ✎ left, send right) — pi-hub composer style.
		const controls = document.createElement("div");
		controls.className = "composer-controls";
		controls.append(this.attachButton, this.sessionMenuBtn, this.editorBtn, this.button);
		const box = document.createElement("div");
		box.className = "composer-box";
		box.append(this.textarea, controls);
		this.toolbar = this.buildToolbar();
		this.toolbar.hidden = true;
		root.append(this.attachmentsRow, this.atMenu, this.slashMenu, this.toolbar, box);
	}

	// ------------------------------------------------------------------
	// Capability toolbar (model / thinking / skills / compact / context %)
	// ------------------------------------------------------------------

	private chipButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.className = "composer-chip";
		btn.textContent = text;
		btn.title = title;
		btn.addEventListener("click", () => onClick());
		return btn;
	}

	private buildToolbar(): HTMLElement {
		const bar = document.createElement("div");
		bar.className = "composer-toolbar";
		this.modelBtn = this.chipButton("◈ Model", "Pick the session model", () => void this.pickModel().catch((err) => this.showError(err)));
		this.thinkingBtn = this.chipButton("✦ Thinking", "Pick the thinking level", () => void this.pickThinking().catch((err) => this.showError(err)));
		const sep = document.createElement("span");
		sep.className = "toolbar-sep";
		const spacer = document.createElement("span");
		spacer.className = "toolbar-spacer";
		this.skillsBtn = this.chipButton("⌘ Skills", "Insert a /skill invocation", () => this.toggleSkills());
		this.compactBtn = this.chipButton("⤓ Compact", "Compact the context now", () => void this.onCompact().catch((err) => this.showError(err)));
		// Steer status: shows the send mode for the next message (click toggles)
		// and the pending queue count; clear appears when messages are queued.
		this.queueChip = this.chipButton("⇢", "Queue status", () => {
			this.sendMode = this.sendMode === "steer" ? "followUp" : "steer";
			this.renderQueueStatus(store.active);
		});
		this.queueChip.hidden = true;
		this.queueClearBtn = this.chipButton("✕", "Drop all queued messages", () => {
			const tabId = store.activeTabId;
			if (tabId) void window.pi.clearQueue(tabId).catch((err) => this.showError(err));
		});
		this.queueClearBtn.hidden = true;
		bar.append(this.modelBtn, this.thinkingBtn, sep, this.skillsBtn, this.compactBtn, this.queueChip, this.queueClearBtn, spacer);
		// Last-exchange usage: in / cache-read / output tokens + cost.
		this.usageChip = document.createElement("span");
		this.usageChip.className = "composer-chip composer-chip-static";
		this.usageChip.hidden = true;
		// Context gauge: mini fill bar + percent, right-aligned.
		this.ctxChip = document.createElement("span");
		this.ctxChip.className = "composer-chip composer-chip-static";
		this.ctxGauge = document.createElement("span");
		this.ctxGauge.className = "ctx-gauge";
		this.ctxFill = document.createElement("span");
		this.ctxFill.className = "ctx-gauge-fill";
		this.ctxGauge.append(this.ctxFill);
		this.ctxLabel = document.createElement("span");
		this.ctxLabel.textContent = "—";
		this.ctxChip.append(this.ctxGauge, this.ctxLabel);
		bar.append(this.usageChip, this.ctxChip);
		return bar;
	}

	setActions(actions: TabActions): void {
		this.actions = actions;
	}

	/** Session-actions menu, anchored upward (the composer sits at the bottom). */
	private openSessionMenu(anchor: HTMLElement): void {
		document.querySelector(".profile-menu")?.remove();
		const tab = store.active;
		if (!tab || !this.actions) return;
		const actions = this.actions;
		const menu = document.createElement("div");
		menu.className = "profile-menu";
		const persisted = tab.meta?.persisted === true;
		const item = (text: string, run: () => void, opts: { disabled?: boolean; title?: string } = {}) => {
			const row = document.createElement("div");
			row.className = "profile-menu-item";
			if (opts.disabled) row.classList.add("profile-menu-disabled");
			row.textContent = text;
			if (opts.title) row.title = opts.title;
			if (!opts.disabled) {
				row.addEventListener("click", () => {
					menu.remove();
					run();
				});
			}
			menu.append(row);
		};
		item("Rename session…", () => actions.rename(tab));
		item("Clone (branch copy, same history)", () => actions.clone(tab), {
			disabled: !persisted,
			title: persisted ? "New transcript file with the full history" : "Available after the first assistant reply",
		});
		item("Change folder… (/cd)", () => actions.changeFolder(tab));
		item("Fork from message…", () => actions.forkMessage(tab));
		item("Rewind to message…", () => actions.rewind(tab));
		const sepRow = document.createElement("div");
		sepRow.className = "profile-menu-sep";
		menu.append(sepRow);
		item("Create/improve AGENTS.md (/init)", () => actions.createAgentsMd(tab));
		const rect = anchor.getBoundingClientRect();
		menu.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;
		menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
		document.body.append(menu);
		const dismiss = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				menu.remove();
				document.removeEventListener("mousedown", dismiss);
			}
		};
		document.addEventListener("mousedown", dismiss);
	}

	private showError(err: unknown): void {
		this.dialogs.notify(`Error: ${String((err as Error).message ?? err)}`, "error");
	}

	private async pickModel(): Promise<void> {
		const tab = store.active;
		if (!tab) return;
		const models = await window.pi.listModels(tab.tabId);
		const chosen = await this.dialogs.selectLocal("Model", [
			{ id: "", label: "→ cycle to the next model" },
			...models.map((model) => ({ id: model.ref, label: `${model.current ? "● " : "  "}${model.ref}` })),
		]);
		if (chosen === undefined) return;
		const ref = await window.pi.setModel(tab.tabId, chosen);
		this.dialogs.notify(`Model: ${ref || "(none)"}`, "info");
	}

	private async pickThinking(): Promise<void> {
		const tab = store.active;
		const levels = tab?.meta?.availableThinkingLevels ?? [];
		if (!tab || levels.length === 0) {
			this.dialogs.notify("No thinking levels available for the current model.", "info");
			return;
		}
		const current = tab.meta?.thinkingLevel;
		const chosen = await this.dialogs.selectLocal(
			"Thinking level",
			levels.map((level) => ({ id: level, label: `${level === current ? "● " : "  "}${level}` })),
		);
		if (chosen === undefined) return;
		await window.pi.setThinkingLevel(tab.tabId, chosen);
	}

	private toggleSkills(): void {
		this.closeSkills();
		const tab = store.active;
		if (!tab) return;
		const popover = document.createElement("div");
		popover.className = "skill-pop";
		popover.textContent = "Loading skills…";
		// A row click must not blur-lose the textarea caret before the insert.
		popover.addEventListener("mousedown", (e) => e.preventDefault());
		const rect = this.skillsBtn.getBoundingClientRect();
		popover.style.left = `${rect.left}px`;
		popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
		document.body.append(popover);
		this.skillsPopover = popover;
		const dismiss = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node)) this.closeSkills();
		};
		document.addEventListener("mousedown", dismiss);
		this.closeSkillsPopover = () => {
			document.removeEventListener("mousedown", dismiss);
			popover.remove();
			this.skillsPopover = null;
			this.closeSkillsPopover = null;
		};
		const requestTab = tab.tabId;
		void window.pi
			.listSkills(requestTab)
			.then((skills) => {
				if (!this.skillsPopover || store.activeTabId !== requestTab) return;
				this.renderSkills(skills, popover);
			})
			.catch((err) => this.showError(err));
	}

	private renderSkills(skills: SkillDTO[], popover: HTMLElement): void {
		if (skills.length === 0) {
			popover.replaceChildren(this.skillRow("(no skills found — add SKILL.md under <agentDir>/skills or .pi/skills)", "", () => {}));
			return;
		}
		popover.replaceChildren(
			...skills.map((skill) =>
				this.skillRow(
					`/skill:${skill.name}`,
					skill.disableModelInvocation ? `${skill.description} (explicit invocation only)` : skill.description,
					() => {
						this.insertAtCaret(`/skill:${skill.name} `);
						this.closeSkills();
					},
				),
			),
		);
	}

	private skillRow(name: string, description: string, run: () => void): HTMLElement {
		const row = document.createElement("div");
		row.className = "skill-row";
		row.append(document.createTextNode(name));
		if (description) {
			const desc = document.createElement("span");
			desc.className = "skill-row-desc";
			desc.textContent = ` — ${description}`;
			row.append(desc);
		}
		row.addEventListener("click", run);
		return row;
	}

	private closeSkills(): void {
		this.closeSkillsPopover?.();
	}

	/** Insert text at the textarea caret (used by the skills popover). */
	private insertAtCaret(text: string): void {
		const value = this.textarea.value;
		const caret = this.textarea.selectionStart ?? value.length;
		this.textarea.value = value.slice(0, caret) + text + value.slice(caret);
		const next = caret + text.length;
		this.textarea.setSelectionRange(next, next);
		this.textarea.focus();
	}

	private async onCompact(): Promise<void> {
		const tab = store.active;
		if (!tab) return;
		if (tab.compacting) {
			await window.pi.abortCompaction(tab.tabId);
			return;
		}
		const instructions = await this.dialogs.promptLocal(
			"Compact the context now",
			"",
			"Optional focus instructions — leave empty to skip",
		);
		if (instructions === undefined) return;
		const result = await window.pi.compact(tab.tabId, instructions || undefined);
		const after = result.estimatedTokensAfter === undefined ? "?" : `~${formatTokens(result.estimatedTokensAfter)}`;
		this.dialogs.notify(`Compacted ${formatTokens(result.tokensBefore)} → ${after} tokens`, "info");
	}

	// ------------------------------------------------------------------
	// Merged status pieces: queue (steer) + last-exchange usage
	// ------------------------------------------------------------------

	private renderQueueStatus(active: TabState | undefined): void {
		const steering = active?.queue.steering ?? [];
		const followUp = active?.queue.followUp ?? [];
		const queued = steering.length + followUp.length;
		const show = Boolean(active) && (active?.streaming === true || queued > 0);
		this.queueChip.hidden = !show;
		this.queueClearBtn.hidden = !show || queued === 0;
		if (!show || !active) return;
		const modeLabel = this.sendMode === "steer" ? "steer" : "follow-up";
		this.queueChip.textContent = `⇢ next: ${modeLabel}${queued ? ` · ${queued} queued` : ""}`;
		const lines: string[] = [];
		for (const text of steering) lines.push(`Steering: ${text}`);
		for (const text of followUp) lines.push(`Follow-up: ${text}`);
		this.queueChip.title = `Next message queues as ${modeLabel} — click to toggle${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
	}

	/** Usage of the most recent finalized assistant exchange, if any. */
	private lastUsage(tab: TabState | undefined): NonNullable<ChatMessageDTO["usage"]> | null {
		if (!tab) return null;
		for (let i = tab.items.length - 1; i >= 0; i--) {
			const item = tab.items[i];
			if (item?.kind === "assistant" && item.message.usage) return item.message.usage;
		}
		return null;
	}

	private renderUsage(active: TabState | undefined): void {
		const usage = this.lastUsage(active);
		this.usageChip.hidden = !usage;
		if (!usage) return;
		const group = (n: number) => n.toLocaleString("en-US");
		const seg = (text: string, title: string, cls?: string): HTMLElement => {
			const span = document.createElement("span");
			span.textContent = text;
			span.title = title;
			if (cls) span.className = cls;
			return span;
		};
		const segments: HTMLElement[] = [seg(`↑ ${formatTokens(usage.input)}`, `Input tokens (prompt + history): ${group(usage.input)}`)];
		if (usage.cacheRead || usage.cacheWrite) {
			segments.push(seg(`⚡ ${formatTokens(usage.cacheRead)}`, `Cache read / written tokens: ${group(usage.cacheRead)} / ${group(usage.cacheWrite)}`, "usage-seg-cache"));
		}
		segments.push(seg(`↓ ${formatTokens(usage.output)}`, `Output tokens (assistant reply): ${group(usage.output)}`));
		if (usage.costTotal) {
			segments.push(seg(`$${usage.costTotal < 1 ? usage.costTotal.toFixed(4) : usage.costTotal.toFixed(2)}`, `Cost of this exchange: $${usage.costTotal.toFixed(6)}`, "usage-seg-cost"));
		}
		this.usageChip.replaceChildren(...segments);
		this.usageChip.title = `Last exchange — total ${group(usage.total)} tokens (input ${group(usage.input)}, cache read ${group(usage.cacheRead)}, output ${group(usage.output)})`;
	}

	/** Load text into the input (fork/rewind bring back the chosen message). */
	loadText(text: string): void {
		this.textarea.value = text;
		this.focus();
	}

	/** Round-trip the draft through the external editor (blocks until it exits).
	 *  Public for the ⌘⌥E menu accelerator (main.ts routes it here). */
	async editExternally(): Promise<void> {
		try {
			const edited = await window.pi.openInEditor(this.textarea.value);
			// undefined = editor produced an empty file — keep the draft as-is.
			if (edited !== undefined) this.loadText(edited);
		} catch (err) {
			this.dialogs.notify(`External editor failed: ${String((err as Error).message ?? err)}`, "error");
		}
	}

	// ------------------------------------------------------------------
	// Attachments (paperclip + @-menu share the chip pipeline)
	// ------------------------------------------------------------------

	private async pickFiles(): Promise<void> {
		const paths = await window.pi.pickFiles();
		for (const path of paths) this.addAttachment(path);
	}

	private addAttachment(path: string, isFolder = false): void {
		if (this.attachments.includes(path)) return;
		this.attachments.push(path);
		if (isFolder) this.folderPaths.add(path);
		this.renderAttachments();
	}

	/** Put paths back after a failed send so a retry keeps them. */
	restoreAttachments(paths: string[]): void {
		for (const path of paths) {
			if (!this.attachments.includes(path)) this.attachments.push(path);
		}
		this.renderAttachments();
	}

	private removeAttachment(path: string): void {
		this.attachments = this.attachments.filter((p) => p !== path);
		this.folderPaths.delete(path);
		this.renderAttachments();
	}

	private renderAttachments(): void {
		this.attachmentsRow.hidden = this.attachments.length === 0;
		this.attachmentsRow.replaceChildren(
			...this.attachments.map((path) => {
				const chip = document.createElement("span");
				chip.className = "attachment-chip";
				chip.title = path;
				if (isImagePath(path)) {
					const thumb = document.createElement("img");
					thumb.className = "attachment-thumb";
					void thumbSrc(path).then((src) => {
						if (src) thumb.src = src;
						else thumb.remove(); // unreadable -> plain chip
					});
					chip.append(thumb);
				} else if (this.folderPaths.has(path)) {
					chip.append(document.createTextNode("📁 "));
				}
				chip.append(document.createTextNode(basename(path)));
				const remove = document.createElement("button");
				remove.className = "attachment-chip-remove";
				remove.textContent = "×";
				remove.addEventListener("click", () => this.removeAttachment(path));
				chip.append(remove);
				return chip;
			}),
		);
	}

	// ------------------------------------------------------------------
	// "@" mention menu
	// ------------------------------------------------------------------

	private updateAtMenu(): void {
		if (this.suppressAtNext) {
			this.suppressAtNext = false;
			this.closeAtMenu();
			return;
		}
		const value = this.textarea.value;
		const caret = this.textarea.selectionStart ?? value.length;
		const tok = findAtToken(value, caret);
		if (!tok || tok.raw.startsWith("/")) {
			this.closeAtMenu();
			return;
		}
		const slash = tok.raw.lastIndexOf("/");
		const dir = tok.raw.slice(0, slash + 1);
		const filter = tok.raw.slice(slash + 1);
		// The menu is clamped to the cwd tree; typed traversal is not honored.
		if (dir.split("/").includes("..")) {
			this.closeAtMenu();
			return;
		}
		const prev = this.at;
		if (prev && prev.dir === dir && prev.filter === filter) {
			// Same token (caret nudge, or edits outside it shifted indices): keep
			// the arrow-key selection, just refresh the splice offset.
			prev.atStart = tok.atStart;
			return;
		}
		this.at = { atStart: tok.atStart, dir, filter, entries: [], truncated: false, loading: false, active: 0 };
		this.refreshAtEntries();
	}

	private refreshAtEntries(): void {
		const at = this.at;
		if (!at) return;
		// The prefix filter runs in main (applied before its entry cap), so the
		// per-fetch cache key includes it.
		const key = `${at.dir}:${at.filter.toLowerCase()}`;
		const cached = this.atCache.get(key);
		if (cached) {
			this.applyListing(cached);
			return;
		}
		const tabId = store.activeTabId;
		if (!tabId) {
			this.applyListing({ entries: [], truncated: false });
			return;
		}
		at.loading = true;
		at.entries = [];
		this.renderAtMenu();
		const request = ++this.atRequest;
		const dir = at.dir;
		const filter = at.filter;
		const settle = (res: ListDirResultDTO): void => {
			this.atCache.set(key, res);
			if (request !== this.atRequest || !this.at || this.at.dir !== dir || this.at.filter.toLowerCase() !== filter.toLowerCase()) return;
			this.applyListing(res);
		};
		// The main handler never rejects for fs errors, but keep the renderer
		// honest about an IPC failure instead of spinning forever.
		void window.pi.listDir(tabId, dir, filter).then(settle).catch(() => settle({ entries: [], truncated: false }));
	}

	private applyListing(res: ListDirResultDTO): void {
		const at = this.at;
		if (!at) return;
		at.loading = false;
		// Main already applied the prefix filter (and kept the ".." row).
		at.entries = res.entries;
		at.truncated = res.truncated;
		// Prose like "hi @bob there": an unmatched token that contains spaces is
		// almost certainly not a path — drop the menu so Enter keeps sending.
		if (at.entries.length === 0 && /\s/.test(at.filter)) {
			this.closeAtMenu();
			return;
		}
		if (at.active >= at.entries.length) at.active = 0;
		this.renderAtMenu();
	}

	private renderAtMenu(): void {
		const at = this.at;
		if (!at) return;
		const rows: HTMLElement[] = at.entries.map((entry, i) => {
			const row = document.createElement("div");
			row.className = i === at.active ? "at-row at-row-active" : "at-row";
			const icon = document.createElement("span");
			icon.className = "at-row-icon";
			icon.textContent = entry.name === ".." ? "↩" : entry.isDir ? "📁" : "📄";
			const name = document.createElement("span");
			name.className = "at-row-name";
			name.textContent = entry.name;
			name.title = entry.relPath || at.dir;
			row.append(icon, name);
			if (entry.isDir && entry.name !== "..") {
				// Enter navigates into dirs; attaching one is the paperclip button.
				const attach = document.createElement("button");
				attach.className = "at-row-attach";
				attach.title = `Attach folder "${entry.name}"`;
				attach.append(paperclipSvg());
				attach.addEventListener("click", (e) => {
					e.stopPropagation();
					this.attachFromAt(entry);
				});
				row.append(attach);
			}
			row.addEventListener("click", () => (entry.isDir ? this.navigateAt(entry) : this.attachFromAt(entry)));
			return row;
		});
		if (at.loading && at.entries.length === 0) rows.push(this.atEmptyRow("…"));
		else if (at.entries.length === 0) rows.push(this.atEmptyRow("No matches"));
		else if (at.truncated) rows.push(this.atEmptyRow("More items — keep typing to narrow"));
		this.atMenu.replaceChildren(...rows);
		this.atMenu.hidden = false;
		this.atMenu.querySelector(".at-row-active")?.scrollIntoView({ block: "nearest" });
	}

	private atEmptyRow(text: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "at-empty";
		row.textContent = text;
		return row;
	}

	private handleAtKeydown(e: KeyboardEvent): boolean {
		const at = this.at;
		if (!at) return false;
		switch (e.key) {
			case "Escape":
				this.closeAtMenu();
				return true;
			case "ArrowDown":
			case "ArrowUp": {
				const n = at.entries.length;
				if (n === 0) return false;
				e.preventDefault();
				at.active = (at.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
				this.renderAtMenu();
				return true;
			}
			case "Enter":
			case "Tab": {
				// Nothing selectable: let Enter reach the send path / Tab move focus.
				if (at.entries.length === 0) return false;
				e.preventDefault();
				const entry = at.entries[at.active];
				if (entry) {
					if (entry.isDir) this.navigateAt(entry);
					else this.attachFromAt(entry);
				}
				return true;
			}
			default:
				return false;
		}
	}

	/** Replace the token (including its "@") with new text, then re-evaluate. */
	private replaceAtToken(newText: string): void {
		const at = this.at;
		if (!at) return;
		const value = this.textarea.value;
		const end = at.atStart + 1 + at.dir.length + at.filter.length;
		this.textarea.value = value.slice(0, at.atStart) + newText + value.slice(end);
		const caret = at.atStart + newText.length;
		this.textarea.setSelectionRange(caret, caret);
		this.at = null; // force a fresh evaluation of the edited token
		this.updateAtMenu();
	}

	private navigateAt(entry: DirEntryDTO): void {
		// ".." carries the parent's relPath ("" when the parent is the cwd root).
		const nextRaw = entry.name === ".." ? (entry.relPath ? `${entry.relPath}/` : "") : `${entry.relPath}/`;
		this.replaceAtToken(`@${nextRaw}`);
	}

	private attachFromAt(entry: DirEntryDTO): void {
		const abs = this.absolutePath(entry.relPath);
		// Keep a visible inline reference in the sentence; the chip carries the
		// read instruction to the agent. The trailing space ends the token and
		// the suppress flag stops the menu from reopening on the inserted path.
		const inline = `@${entry.relPath}${entry.isDir ? "/" : ""} `;
		this.suppressAtNext = true;
		this.replaceAtToken(inline);
		if (abs) this.addAttachment(abs, entry.isDir);
	}

	/** Entries arrive cwd-relative; attachments are absolute paths. */
	private absolutePath(relPath: string): string | undefined {
		const cwd = store.active?.cwd;
		if (!cwd || !relPath) return undefined;
		return cwd === "/" ? `/${relPath}` : `${cwd}/${relPath}`;
	}

	private closeAtMenu(): void {
		this.at = null;
		this.atRequest++; // drop any in-flight listing
		this.atMenu.hidden = true;
		this.atMenu.replaceChildren();
	}

	// ------------------------------------------------------------------
	// "/" slash-command menu (TUI-style)
	// ------------------------------------------------------------------

	private updateSlashMenu(): void {
		const value = this.textarea.value;
		const caret = this.textarea.selectionStart ?? value.length;
		const tok = findSlashToken(value, caret);
		if (!tok) {
			this.closeSlashMenu();
			return;
		}
		const filter = tok.raw.slice(1);
		const prev = this.slash;
		if (prev && prev.filter === filter) {
			// Caret nudge or edits outside the token: keep the selection, refresh the offset.
			prev.slashStart = tok.slashStart;
			return;
		}
		this.slash = { slashStart: tok.slashStart, filter, entries: [], active: 0 };
		this.closeAtMenu();
		this.refreshSlashEntries();
	}

	private refreshSlashEntries(): void {
		const slash = this.slash;
		if (!slash) return;
		const tabId = store.activeTabId;
		const filter = slash.filter;
		const request = ++this.slashRequest;
		const apply = (commands: CommandDTO[]): void => {
			if (request !== this.slashRequest || !this.slash || this.slash.filter !== filter) return;
			const lower = filter.toLowerCase();
			this.slash.entries = commands.filter(
				(c) => !lower || c.name.toLowerCase().includes(lower) || (c.description ?? "").toLowerCase().includes(lower),
			);
			this.slash.active = 0;
			this.renderSlashMenu();
		};
		if (!tabId) {
			apply([]);
			return;
		}
		const cached = this.slashCache.get(tabId);
		if (cached) {
			apply(cached);
			return;
		}
		void window.pi
			.listCommands(tabId)
			.then((commands) => {
				this.slashCache.set(tabId, commands);
				apply(commands);
			})
			.catch(() => apply([]));
	}

	private renderSlashMenu(): void {
		const slash = this.slash;
		if (!slash) return;
		const rows: HTMLElement[] = slash.entries.map((cmd, i) => {
			const row = document.createElement("div");
			row.className = i === slash.active ? "at-row at-row-active" : "at-row";
			const name = document.createElement("span");
			name.className = "slash-row-name";
			name.textContent = `/${cmd.name}`;
			const desc = document.createElement("span");
			desc.className = "slash-row-desc";
			desc.textContent = cmd.description ?? cmd.source;
			row.append(name, desc);
			row.addEventListener("click", () => this.selectSlash(cmd));
			return row;
		});
		if (rows.length === 0) {
			const empty = document.createElement("div");
			empty.className = "at-empty";
			empty.textContent = "No matching commands";
			rows.push(empty);
		}
		this.slashMenu.replaceChildren(...rows);
		this.slashMenu.hidden = false;
		this.slashMenu.querySelector(".at-row-active")?.scrollIntoView({ block: "nearest" });
	}

	private handleSlashKeydown(e: KeyboardEvent): boolean {
		const slash = this.slash;
		if (!slash || this.slashMenu.hidden) return false;
		switch (e.key) {
			case "Escape":
				this.closeSlashMenu();
				return true;
			case "ArrowDown":
			case "ArrowUp": {
				const n = slash.entries.length;
				if (n === 0) return false;
				e.preventDefault();
				slash.active = (slash.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
				this.renderSlashMenu();
				return true;
			}
			case "Enter":
			case "Tab": {
				// No candidates: let Enter send the message / Tab move focus.
				const cmd = slash.entries[slash.active];
				if (!cmd) return false;
				e.preventDefault();
				this.selectSlash(cmd);
				return true;
			}
			default:
				return false;
		}
	}

	/** Replace the "/" token with the chosen invocation, leaving the caret to type args. */
	private selectSlash(cmd: CommandDTO): void {
		const slash = this.slash;
		if (!slash) return;
		const value = this.textarea.value;
		const end = slash.slashStart + 1 + slash.filter.length;
		const insert = `/${cmd.name} `;
		this.textarea.value = value.slice(0, slash.slashStart) + insert + value.slice(end);
		const caret = slash.slashStart + insert.length;
		this.textarea.setSelectionRange(caret, caret);
		this.closeSlashMenu();
	}

	private closeSlashMenu(): void {
		this.slash = null;
		this.slashRequest++; // drop any in-flight fetch
		this.slashMenu.hidden = true;
		this.slashMenu.replaceChildren();
	}

	private submit(): void {
		const text = this.textarea.value.trim();
		if (!text) return;
		if (!store.activeTabId) return;
		const attachments = this.attachments;
		const mode = store.active?.streaming ? this.sendMode : undefined;
		this.textarea.value = "";
		this.attachments = [];
		this.folderPaths.clear();
		this.closeAtMenu();
		this.closeSlashMenu();
		this.renderAttachments();
		this.onSend(text, attachments, mode);
	}

	/** Reflect the active tab's state (streaming -> Stop, else Send). */
	sync(): void {
		const active = store.active;
		const ready = Boolean(active);
		this.textarea.disabled = !ready;
		this.button.disabled = !ready;
		this.attachButton.disabled = !ready;
		this.sessionMenuBtn.disabled = !ready;
		if (active?.streaming) {
			this.button.textContent = "■";
			this.button.title = "Stop this turn (Esc)";
			this.button.classList.add("composer-stop");
		} else {
			this.button.textContent = "↑";
			this.button.title = "Send (Enter)";
			this.button.classList.remove("composer-stop");
		}
		if (active) {
			this.textarea.placeholder = `Message pi… (${active.cwd})`;
		}
		this.syncToolbar(active);
		// Per-tab chatbox: park the leaving tab's draft, restore the entering
		// tab's. A tab switch also changes the cwd the listings came from.
		if (store.activeTabId !== this.lastTabId) {
			const prev = this.lastTabId ? store.tabs.get(this.lastTabId) : undefined;
			if (prev) {
				prev.draft = this.textarea.value;
				prev.draftAttachments = [...this.attachments];
				prev.draftFolders = [...this.folderPaths];
			}
			this.lastTabId = store.activeTabId;
			this.textarea.value = active?.draft ?? "";
			this.attachments = active ? [...active.draftAttachments] : [];
			this.folderPaths = new Set(active?.draftFolders ?? []);
			this.renderAttachments();
			this.closeAtMenu();
			this.closeSlashMenu();
			this.closeSkills();
			this.atCache.clear();
			this.slashCache.clear();
		}
	}

	private syncToolbar(active: TabState | undefined): void {
		this.toolbar.hidden = !active;
		const model = active?.meta?.model;
		this.modelBtn.textContent = `◈ ${model ? shortModel(model) : "Model"}`;
		this.modelBtn.title = model ? `Model — ${model}` : "Pick the session model";
		this.modelBtn.disabled = !active;
		this.thinkingBtn.textContent = active?.meta ? `✦ ${active.meta.thinkingLevel}` : "✦ Thinking";
		this.thinkingBtn.disabled = !active;
		this.skillsBtn.disabled = !active;
		if (active?.compacting) {
			this.compactBtn.textContent = "✕ Abort compaction";
			this.compactBtn.classList.add("composer-chip-danger");
		} else {
			this.compactBtn.textContent = "⤓ Compact";
			this.compactBtn.classList.remove("composer-chip-danger");
		}
		this.compactBtn.disabled = !active;
		const usage = active?.meta?.contextUsage;
		if (usage && usage.percent !== null) {
			const percent = usage.percent;
			this.ctxLabel.textContent = `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
			this.ctxFill.style.width = `${Math.min(100, percent)}%`;
			this.ctxChip.classList.toggle("ctx-chip-warn", percent >= 80);
			this.ctxChip.classList.toggle("ctx-chip-danger", percent >= 95);
			this.ctxChip.title = `context: ${usage.tokens === null ? "?" : formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`;
		} else {
			this.ctxLabel.textContent = "—";
			this.ctxFill.style.width = "0%";
			this.ctxChip.classList.remove("ctx-chip-warn", "ctx-chip-danger");
			this.ctxChip.title = "context usage unknown (send a message to measure)";
		}
		this.renderQueueStatus(active);
		this.renderUsage(active);
	}

	focus(): void {
		this.textarea.focus();
	}
}
