/**
 * Renderer entry for the dedicated Settings window: a left category panel
 * (Profiles / Appearance / Permissions / Compaction / Editors / MCP) switching
 * the right pane. Profiles are shown as a
 * card grid with Add / Edit / Delete / Set Default buttons; double-click a
 * card also opens the edit form. Loads over the same preload surface as the
 * main window (window.pi).
 */

import "../styles.css";
import type { CompactionPatch, CompactionSettingsDTO, PermissionMode, ProfileDTO, ProfilesDataDTO, ThemeMode } from "../../shared/ipc-types.ts";
import { buildMcpPane } from "./mcp-pane.ts";
import { ProfileForm } from "./profile-form.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const $ = <T extends HTMLElement>(selector: string): T => {
	const node = document.querySelector<T>(selector);
	if (!node) throw new Error(`Missing element ${selector}`);
	return node;
};

const THEME_MODES: { label: string; mode: ThemeMode }[] = [
	{ label: "Follow System", mode: "system" },
	{ label: "Light", mode: "light" },
	{ label: "Dark", mode: "dark" },
];

// Model chips shown per card before collapsing into a "+N" chip.
const MAX_MODEL_CHIPS = 3;

// SDK-enforced per-profile model bound (hub addProfileModel); hides the
// "+ model" chip once reached.
const MAX_PROFILE_MODELS = 3;

/** Compact prompt for adding one model to a profile. Errors (duplicate,
 *  empty, fourth model) show inline; success closes the dialog and the card
 *  re-renders via the profilesChanged broadcast. */
function openAddModelDialog(name: string): void {
	document.querySelector(".dialog-overlay")?.remove();
	const overlay = el("div", "dialog-overlay");
	const box = el("div", "dialog-box dialog-form");
	box.append(el("div", "dialog-title", `Add model to '${name}'`));
	const row = el("label", "form-row");
	row.append(el("span", "form-label", "Model"));
	const input = el("input", "form-input") as HTMLInputElement;
	input.placeholder = "model-id";
	row.append(input);
	const errorRow = el("div", "form-error");
	const buttons = el("div", "dialog-buttons");
	const add = el("button", "dialog-btn dialog-btn-primary", "Add");
	const cancel = el("button", "dialog-btn", "Cancel");
	const submit = (): void => {
		const model = input.value.trim();
		if (!model) {
			errorRow.textContent = "Model is required.";
			return;
		}
		window.pi
			.addProfileModel(name, model)
			.then(() => overlay.remove())
			.catch((err) => {
				errorRow.textContent = String((err as Error).message ?? err);
			});
	};
	add.addEventListener("click", submit);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") submit();
		if (e.key === "Escape") overlay.remove();
	});
	cancel.addEventListener("click", () => overlay.remove());
	buttons.append(add, cancel);
	box.append(row, errorRow, buttons);
	overlay.append(box);
	overlay.addEventListener("mousedown", (e) => {
		if (e.target === overlay) overlay.remove();
	});
	document.body.append(overlay);
	input.focus();
}

type Categories = { label: string; pane: HTMLElement }[];

function init(): void {
	const root = $<HTMLElement>("#settings-root");
	const profileForm = new ProfileForm($<HTMLElement>("#modal-root"));

	const layout = el("div", "settings-layout");
	const nav = el("div", "settings-nav");
	const content = el("div", "settings-content");
	layout.append(nav, content);
	root.append(layout);

	const navItems = new Map<string, HTMLButtonElement>();
	const selectCategory = (label: string, categories: Categories) => {
		for (const [name, item] of navItems) item.classList.toggle("settings-nav-item-active", name === label);
		for (const category of categories) category.pane.hidden = category.label !== label;
	};

	// ---- Profiles pane ----
	const profilesPane = el("div", "settings-pane");
	const toolbar = el("div", "settings-toolbar");
	const profilesGrid = el("div", "settings-grid");
	profilesPane.append(toolbar, profilesGrid);

	let selected: string | null = null; // active card key; null = nothing selected

	const editBtn = el("button", "dialog-btn", "Edit") as HTMLButtonElement;
	const deleteBtn = el("button", "dialog-btn", "Delete") as HTMLButtonElement;
	const defaultBtn = el("button", "dialog-btn", "Set Default") as HTMLButtonElement;
	const addBtn = el("button", "dialog-btn dialog-btn-primary", "Add");
	const toolbarSpacer = el("div", "settings-toolbar-spacer");

	const refreshToolbar = () => {
		editBtn.disabled = selected === null;
		deleteBtn.disabled = selected === null;
		defaultBtn.disabled = selected === null;
	};

	addBtn.addEventListener("click", () => profileForm.openCreate());
	editBtn.addEventListener("click", () => {
		if (selected !== null) profileForm.openEdit(selected);
	});
	deleteBtn.addEventListener("click", () => {
		if (selected !== null) profileForm.openDelete(selected);
	});
	defaultBtn.addEventListener("click", () => {
		if (selected !== null) void window.pi.setDefaultProfile(selected).catch((err) => console.warn("[settings] setDefault failed", err));
	});
	// Add/Edit on the left, destructive/default actions pushed to the right.
	toolbar.append(addBtn, editBtn, toolbarSpacer, deleteBtn, defaultBtn);

	const renderProfiles = (data: ProfilesDataDTO) => {
		if (selected !== null && !data.profiles[selected]) selected = null;
		refreshToolbar();

		profilesGrid.replaceChildren();

		const makeCard = (name: string, profile: ProfileDTO, isDefault: boolean) => {
			const card = el("button", "settings-card");

			const head = el("div", "settings-card-head");
			head.append(el("span", "settings-card-name", name));
			if (isDefault) head.append(el("span", "settings-card-badge", "Default"));
			card.append(head);

			if (profile.provider) card.append(el("div", "settings-card-meta", profile.provider));

			// Configured models as chips: the active one is highlighted, clicking
			// another makes it the default, and every chip carries a × that
			// removes the model (deleting the default promotes the next one).
			// Cards re-render via the profilesChanged broadcast, so no manual
			// refresh here.
			const models = profile.models ?? [];
			const chips = el("div", "settings-card-models");
			const makeChip = (model: string, isActive: boolean) => {
				const chip = el("span", isActive ? "model-chip model-chip-active" : "model-chip");
				chip.append(el("span", "model-chip-label", model));
				if (!isActive) {
					chip.title = "Set as default model";
					chip.addEventListener("click", (e) => {
						e.stopPropagation(); // the card is a button — don't treat this as selecting it
						void window.pi
							.setProfileDefaultModel(name, model)
							.catch((err) => console.warn(`[settings] setDefaultModel failed for '${name}'`, err));
					});
				}
				const removeBtn = el("span", "model-chip-x", "×");
				removeBtn.title = "Remove model";
				removeBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					void window.pi
						.removeProfileModel(name, model)
						.catch((err) => console.warn(`[settings] removeModel failed for '${name}'`, err));
				});
				chip.append(removeBtn);
				return chip;
			};
			for (const model of models.slice(0, MAX_MODEL_CHIPS)) chips.append(makeChip(model, model === profile.model));
			if (models.length > MAX_MODEL_CHIPS) chips.append(el("span", "model-chip", `+${models.length - MAX_MODEL_CHIPS}`));
			if (!models.length && profile.model) chips.append(makeChip(profile.model, true));
			if (!models.length && !profile.model) chips.append(el("span", "settings-card-empty", "no models configured"));
			if (models.length < MAX_PROFILE_MODELS) {
				const addChip = el("span", "model-chip model-chip-add", "+ model");
				addChip.title = "Add a model to this profile";
				addChip.addEventListener("click", (e) => {
					e.stopPropagation();
					openAddModelDialog(name);
				});
				chips.append(addChip);
			}
			card.append(chips);

			if (name === selected) card.classList.add("settings-card-selected");
			card.addEventListener("click", () => {
				selected = name;
				refreshToolbar();
				for (const existing of profilesGrid.children) existing.classList.toggle("settings-card-selected", existing === card);
			});
			card.addEventListener("dblclick", () => profileForm.openEdit(name));
			profilesGrid.append(card);
		};

		const names = Object.keys(data.profiles).sort((a, b) => a.localeCompare(b));
		if (!names.length)
			profilesGrid.append(el("div", "settings-empty", "No profiles yet — add one and click Set Default so new tabs start under it."));
		for (const name of names) {
			const profile = data.profiles[name];
			if (profile) makeCard(name, profile, data.default === name);
		}
	};

	// ---- Appearance pane ----
	const appearancePane = el("div", "settings-pane");
	appearancePane.append(el("div", "settings-section-title", "Theme"));
	const themeRow = el("div", "settings-radio-row");
	void window.pi
		.getSettings()
		.then((settings) => {
			for (const { label, mode } of THEME_MODES) {
				const radio = el("label", "settings-radio");
				const input = el("input") as HTMLInputElement;
				input.type = "radio";
				input.name = "theme";
				input.checked = settings.theme === mode;
				input.addEventListener("change", () => {
					if (input.checked) void window.pi.setTheme(mode).catch((err) => console.warn("[settings] setTheme failed", err));
				});
				radio.append(input, el("span", undefined, label));
				themeRow.append(radio);
			}
		})
		.catch((err) => console.warn("[settings] getSettings failed", err));
	appearancePane.append(themeRow);

	// ---- Permissions pane ----
	// Default tool-permission mode for new tabs. The live per-tab switch lives
	// in the chat box's bottom strip (dropdown / Shift+Tab / /permissions);
	// this only seeds the mode each new tab starts with.
	// Plain text glyphs (like ⋯, ✎, ◈ elsewhere) — ⚡ and ⏸ would
	// render as fixed-color emoji and ignore the per-mode CSS tint.
	const PERMISSION_CHOICES: { label: string; mode: PermissionMode; glyph: string; desc: string }[] = [
		{ label: "Bypass", mode: "bypass", glyph: "»", desc: "Every tool runs without asking — pi's classic behavior." },
		{ label: "Accept edits", mode: "acceptEdits", glyph: "✓", desc: "File edits run freely; shell commands and other tools ask first." },
		{ label: "Auto mode", mode: "auto", glyph: "◎", desc: "In-project reads and edits run unattended; everything else is judged by an action classifier, with blocks offered for override." },
		{ label: "Plan mode", mode: "plan", glyph: "∥", desc: "Read-only research — edits and changing shell commands are blocked." },
	];
	const permissionsPane = el("div", "settings-pane");
	permissionsPane.append(el("div", "settings-section-title", "Permissions"));
	const permissionCards = el("div", "permission-cards");
	void window.pi
		.getSettings()
		.then((settings) => {
			for (const { label, mode, glyph, desc } of PERMISSION_CHOICES) {
				// Label-wrapped hidden radio: native group semantics, card styling.
				const card = el("label", `permission-card permission-card-${mode}`);
				const input = el("input") as HTMLInputElement;
				input.type = "radio";
				input.name = "defaultPermissionMode";
				input.checked = settings.defaultPermissionMode === mode;
				input.addEventListener("change", () => {
					if (input.checked)
						void window.pi.setDefaultPermissionMode(mode).catch((err) => console.warn("[settings] setDefaultPermissionMode failed", err));
				});
				const body = el("div", "permission-card-body");
				body.append(el("div", "permission-card-title", label), el("div", "permission-card-desc", desc));
				card.append(input, el("span", "permission-card-icon", glyph), body, el("span", "permission-card-check", "✓"));
				permissionCards.append(card);
			}
		})
		.catch((err) => console.warn("[settings] getSettings failed", err));
	permissionsPane.append(
		permissionCards,
		el(
			"div",
			"settings-hint",
			"New tabs start with the selected mode. Each chat box has a permission dropdown in its bottom button strip; Shift+Tab cycles bypass → accept edits → plan mode, or type /permissions in the chat.",
		),
	);

	// ---- Compaction pane ----
	// Mirrors the pi-plus TUI /settings compaction rows. One file — the base
	// ~/.pi/agent/settings.json — in two blocks: the on/off flag is upstream's
	// `compaction.enabled`, threshold/floor/cap live in the piPlus block.
	const compactionPane = el("div", "settings-pane");
	compactionPane.append(el("div", "settings-section-title", "Compaction"));

	const THRESHOLD_CHOICES = [70, 80, 85, 90, 95];
	const FLOOR_CHOICES = [13000, 16384, 24576, 32768, 65536];
	const CAP_CHOICES: (number | null)[] = [null, 131072, 262144, 524288, 1048576];

	const makeSelect = (choices: (number | null)[], labelFor: (v: number | null) => string): HTMLSelectElement => {
		const select = el("select", "form-input") as HTMLSelectElement;
		for (const choice of choices) {
			const opt = el("option", undefined, labelFor(choice)) as HTMLOptionElement;
			opt.value = choice === null ? "" : String(choice);
			select.append(opt);
		}
		return select;
	};

	/** Set a select to the current value, offering it as an extra option when
	 *  it is outside the TUI's preset list (edited settings.json etc.). */
	const selectSync = (select: HTMLSelectElement, value: number | null): void => {
		const key = value === null ? "" : String(value);
		if (![...select.options].some((o) => o.value === key)) {
			const opt = el("option", undefined, value === null ? "(unset)" : String(value)) as HTMLOptionElement;
			opt.value = key;
			select.append(opt);
		}
		select.value = key;
	};

	const settingRow = (labelText: string, control: HTMLElement, caption: string): HTMLElement => {
		const row = el("label", "settings-field");
		const label = el("span", "settings-field-label", labelText);
		label.append(control);
		row.append(label, el("div", "settings-caption", caption));
		return row;
	};

	const enabledInput = el("input") as HTMLInputElement;
	enabledInput.type = "checkbox";
	const thresholdSelect = makeSelect(THRESHOLD_CHOICES, (v) => `${v}%`);
	const floorSelect = makeSelect(FLOOR_CHOICES, (v) => `${(v ?? 0).toLocaleString("en-US")} tokens`);
	const capSelect = makeSelect(CAP_CHOICES, (v) => (v === null ? "No cap" : v.toLocaleString("en-US") + " tokens"));

	compactionPane.append(
		settingRow("Auto-compact", enabledInput, "Compact automatically as the context fills up. Stored under compaction.enabled in ~/.pi/agent/settings.json — shared with pipi sessions."),
		settingRow("Compact when context reaches", thresholdSelect, "Percent of the model's context window that triggers auto-compaction. Saved in the same file's piPlus block."),
		settingRow("Context floor", floorSelect, "Minimum tokens kept available after a compaction — also the hard reserve compaction targets."),
		settingRow("Context window cap", capSelect, "Treat larger model windows as this many tokens. Applies to pipi sessions too."),
	);

	const syncCompaction = (s: CompactionSettingsDTO): void => {
		enabledInput.checked = s.enabled;
		selectSync(thresholdSelect, s.thresholdPercent);
		selectSync(floorSelect, s.floorTokens);
		selectSync(capSelect, s.windowCapTokens);
	};

	const patchCompaction = (patch: CompactionPatch): void => {
		void window.pi
			.setCompactionSettings(patch)
			.then(syncCompaction)
			.catch((err) => {
				console.warn("[settings] compaction update failed", err);
				// Re-read so the controls stop showing a value that was not applied.
				void window.pi.getCompactionSettings().then(syncCompaction).catch(() => undefined);
			});
	};

	enabledInput.addEventListener("change", () => patchCompaction({ enabled: enabledInput.checked }));
	thresholdSelect.addEventListener("change", () => patchCompaction({ thresholdPercent: Number(thresholdSelect.value) }));
	floorSelect.addEventListener("change", () => patchCompaction({ floorTokens: Number(floorSelect.value) }));
	capSelect.addEventListener("change", () => patchCompaction({ windowCapTokens: capSelect.value === "" ? null : Number(capSelect.value) }));
	void window.pi.getCompactionSettings().then(syncCompaction).catch((err) => console.warn("[settings] getCompactionSettings failed", err));

	// ---- Editors pane ----
	// The composer ✎ button (main/editor.ts) spawns `<command> <tempfile>`,
	// waits for exit, and feeds the file content back into the draft. The
	// picker lists installed blocking-GUI editors (probed main-side).
	const editorsPane = el("div", "settings-pane");
	editorsPane.append(el("div", "settings-section-title", "Editors"));
	const editorSelect = el("select", "form-input editor-select") as HTMLSelectElement;
	// The command is editable: the detected launcher can be wrong (portable
	// installs, wrapper scripts), and a picker-only UI would leave no way to fix it.
	const editorCmdInput = el("input", "form-input editor-cmd-input") as HTMLInputElement;
	editorCmdInput.type = "text";
	editorCmdInput.spellcheck = false;
	editorCmdInput.placeholder = 'e.g. /usr/local/bin/code --wait  or  "C:\\Program Files\\Vim\\vim92\\gvim.exe" -f';
	const editorReset = el("button", "dialog-btn editor-reset", "Reset") as HTMLButtonElement;
	editorReset.title = "Restore the auto-detected command for this editor";
	editorReset.disabled = true;
	// Last probe's detected editors (Reset targets) and the saved command.
	let installedEditors: { label: string; command: string }[] = [];
	let editorSaved = "";
	const persistEditor = (command: string): void => {
		editorSaved = command;
		void window.pi
			.setEditor(command)
			.then(syncEditor)
			.catch((err) => console.warn("[settings] setEditor failed", err));
	};
	const syncEditor = async (): Promise<void> => {
		const [installed, settings] = await Promise.all([window.pi.listEditors(), window.pi.getSettings()]);
		installedEditors = installed;
		editorSaved = settings.editor;
		// No system default: the editor must be picked here explicitly.
		const choices: { label: string; command: string; base: string }[] = installed.map((c) => ({ ...c, base: c.label }));
		// Keep a hand-edited (or since-uninstalled) command selectable. Its base
		// label is whatever it was picked from, so Reset can still find it.
		if (settings.editor && !choices.some((c) => c.command === settings.editor)) {
			const prevBase = editorSelect.selectedOptions[0]?.dataset.base ?? "";
			const base = installed.some((c) => c.label === prevBase) ? prevBase : "";
			choices.push({ label: base ? `${base} (custom)` : `${settings.editor} (custom)`, command: settings.editor, base });
		}
		const placeholder = el("option", undefined, choices.length > 0 ? "Select an editor…" : "No editor found") as HTMLOptionElement;
		placeholder.value = "";
		placeholder.disabled = true;
		editorSelect.replaceChildren(
			placeholder,
			...choices.map((c) => {
				const opt = el("option", undefined, c.label) as HTMLOptionElement;
				opt.value = c.command;
				opt.dataset.base = c.base;
				return opt;
			}),
		);
		editorSelect.value = settings.editor;
		editorCmdInput.value = settings.editor;
		editorReset.disabled = !settings.editor;
	};
	editorSelect.addEventListener("change", () => persistEditor(editorSelect.value));
	// Don't let the click blur the input first: that would commit the typed text
	// right before the reset, racing two saves.
	editorReset.addEventListener("mousedown", (ev) => ev.preventDefault());
	editorReset.addEventListener("click", () => {
		// Detected command for the editor this command came from; clearing is the
		// only meaningful reset for a command that was never auto-detected.
		const base = editorSelect.selectedOptions[0]?.dataset.base ?? "";
		persistEditor(installedEditors.find((c) => c.label === base)?.command ?? "");
	});
	// Commit on blur/Enter rather than per keystroke: a save rewrites the
	// settings file and re-runs detection.
	editorCmdInput.addEventListener("change", () => {
		const next = editorCmdInput.value.trim();
		if (next !== editorSaved) persistEditor(next);
	});
	editorCmdInput.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			editorCmdInput.blur();
		} else if (ev.key === "Escape") {
			editorCmdInput.value = editorSaved;
			editorCmdInput.blur();
		}
	});
	const editorRow = el("div", "editors-row");
	editorRow.append(el("span", "editors-label", "Chat draft editor"), editorSelect);
	const editorCmdRow = el("div", "editors-cmd-row");
	const editorCmdField = el("div", "editor-cmd-field");
	editorCmdField.append(editorCmdInput, editorReset);
	editorCmdRow.append(el("span", "editors-label", "Command"), editorCmdField);
	editorsPane.append(
		el("div", "settings-hint", "Used by the ✎ button at the right of the chat input: the draft opens in this editor and the edited text replaces it once the editor quits."),
		editorRow,
		editorCmdRow,
		el(
			"div",
			"settings-caption",
			"Only editors that block until the file is closed are offered (terminal editors cannot run here — no TTY). Installed apps are detected on PATH and in the usual install locations (macOS: /usr/local/bin, /opt/homebrew/bin; Windows: the VS Code, VSCodium, Cursor, Sublime, Zed and Vim install dirs). The app runs `<command> <tempfile>` and waits for exit, so keep the blocking flag (--wait, or -f for GVim). Edit the command for anything the probe cannot find; Reset restores the detected one.",
		),
	);
	void syncEditor().catch((err) => console.warn("[settings] editors list failed", err));

	// Built once: the MCP pane owns its own state and loads on construction, so a
	// second instance would double every config read.
	const mcpPane = buildMcpPane();

	const categories: Categories = [
		{ label: "Profiles", pane: profilesPane },
		{ label: "Appearance", pane: appearancePane },
		{ label: "Permissions", pane: permissionsPane },
		{ label: "Compaction", pane: compactionPane },
		{ label: "Editors", pane: editorsPane },
		{ label: "MCP", pane: mcpPane },
	];
	for (const { label } of categories) {
		const item = el("button", "settings-nav-item", label) as HTMLButtonElement;
		item.addEventListener("click", () => selectCategory(label, categories));
		navItems.set(label, item);
		nav.append(item);
	}
	content.append(profilesPane, appearancePane, permissionsPane, compactionPane, editorsPane, mcpPane);
	selectCategory("Profiles", categories);

	void window.pi.listProfiles().then(renderProfiles).catch((err) => console.warn("[settings] listProfiles failed", err));
	// Store mutations broadcast from main keep the list fresh across windows.
	window.pi.onProfilesChanged(renderProfiles);
}

init();
