/**
 * App-level settings, backed by the same stores `pipi` uses (pi-plus-sdk) —
 * there is no private userData settings file anymore. The desktop-only chrome
 * keys (desktopTheme / sidebarWidth / defaultPermissionMode) live in the
 * `piPlus` block of the base agent settings.json (~/.pi/agent/settings.json,
 * via the SDK's generic readPiPlusSettings/updatePiPlusSettings), and the
 * external editor maps to the upstream `externalEditor` key of that same file
 * (SettingsManager + the SDK's setExternalEditorCommand pair), so the
 * composer's ✎ button launches exactly what pipi's Ctrl+G would. A legacy
 * userData/settings.json is folded in once at startup (SDK values win on
 * conflict) and retired as settings.json.migrated.
 */

import "./sdk-shim.ts";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { SettingsManager } from "pi-plus-sdk";
import type { PermissionMode, ThemeMode } from "../shared/ipc-types.ts";

// Imported dynamically so the sdk-shim module above installs the global
// require before pi-plus-sdk's ESM bundle evaluates (static external imports
// would be hoisted above the shim by the bundler). Same pattern as
// session-host.ts / profiles.ts; the module-level await keeps load()/save()
// callable from synchronous IPC handlers' setup paths.
const sdk = await import("pi-plus-sdk");
const { getAgentDir, readPiPlusSettings, updatePiPlusSettings } = sdk;

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
const PERMISSION_MODES: PermissionMode[] = ["bypass", "acceptEdits", "plan"];

function asTheme(value: unknown): ThemeMode | undefined {
	return typeof value === "string" && THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : undefined;
}

function asPermissionMode(value: unknown): PermissionMode | undefined {
	return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

function asWidth(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Shape of the retired userData/settings.json (only for the one-time migration). */
interface LegacySettingsFile {
	theme?: unknown;
	editor?: unknown;
	sidebarWidth?: unknown;
	defaultPermissionMode?: unknown;
}

export class AppSettings {
	private _theme: ThemeMode = "system";
	/** Editor command line for the composer's external-edit button ("" = $VISUAL/$EDITOR). */
	private _editor = "";
	/** History panel width, drag-resized in the renderer (CSS clamps applied there). */
	private _sidebarWidth = 260;
	/** Permission mode new tabs start with (Settings → Permissions). */
	private _defaultPermissionMode: PermissionMode = "bypass";

	// Setters mark dirty; save() persists only the touched fields (per store)
	// and clears the flags. load() writes the caches directly, so a fresh read
	// is never re-persisted.
	private dirty = { theme: false, editor: false, sidebarWidth: false, defaultPermissionMode: false };
	private editorManager: SettingsManager | null = null;

	get theme(): ThemeMode {
		return this._theme;
	}
	set theme(value: ThemeMode) {
		if (value !== this._theme) {
			this._theme = value;
			this.dirty.theme = true;
		}
	}

	get editor(): string {
		return this._editor;
	}
	set editor(value: string) {
		if (value !== this._editor) {
			this._editor = value;
			this.dirty.editor = true;
		}
	}

	get sidebarWidth(): number {
		return this._sidebarWidth;
	}
	set sidebarWidth(value: number) {
		if (value !== this._sidebarWidth) {
			this._sidebarWidth = value;
			this.dirty.sidebarWidth = true;
		}
	}

	get defaultPermissionMode(): PermissionMode {
		return this._defaultPermissionMode;
	}
	set defaultPermissionMode(value: PermissionMode) {
		if (value !== this._defaultPermissionMode) {
			this._defaultPermissionMode = value;
			this.dirty.defaultPermissionMode = true;
		}
	}

	/**
	 * Shared SettingsManager over the base agent dir: the desktop never sets
	 * PI_CODING_AGENT_DIR, so getAgentDir() is ~/.pi/agent, and the SDK's
	 * layered factory only engages on hub profile dirs. projectTrusted:false —
	 * an app-setting read must never prompt or load project-scoped files.
	 */
	private editors(): SettingsManager {
		if (!this.editorManager) {
			this.editorManager = sdk.SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
		}
		return this.editorManager;
	}

	load(): void {
		const block = readPiPlusSettings();
		this._theme = asTheme(block.desktopTheme) ?? this._theme;
		this._sidebarWidth = asWidth(block.sidebarWidth) ?? this._sidebarWidth;
		this._defaultPermissionMode = asPermissionMode(block.defaultPermissionMode) ?? this._defaultPermissionMode;
		// Raw persisted value (no $VISUAL/$EDITOR fallback) — resolveEditorCommand
		// in editor.ts applies the fallback at spawn time, as before.
		this._editor = this.editors().getExternalEditorSetting() ?? "";
		this.migrateLegacyFile();
	}

	/** Persist dirty fields; rejects if the queued editor write failed. */
	async save(): Promise<void> {
		const patch: Record<string, unknown> = {};
		if (this.dirty.theme) patch.desktopTheme = this._theme;
		if (this.dirty.sidebarWidth) patch.sidebarWidth = this._sidebarWidth;
		if (this.dirty.defaultPermissionMode) patch.defaultPermissionMode = this._defaultPermissionMode;
		if (Object.keys(patch).length > 0) {
			// Sync + locked merge in the SDK store; a throw keeps the flags dirty
			// so the next save retries.
			updatePiPlusSettings(patch);
			this.dirty.theme = false;
			this.dirty.sidebarWidth = false;
			this.dirty.defaultPermissionMode = false;
		}
		if (this.dirty.editor) {
			this.dirty.editor = false;
			const manager = this.editors();
			const command = this._editor.trim();
			manager.setExternalEditorCommand(command === "" ? undefined : command);
			await manager.flush();
			const errors = manager.drainErrors();
			if (errors.length > 0) {
				throw new Error(`Failed to persist the editor setting: ${errors.map((e) => e.error.message ?? String(e.error)).join("; ")}`);
			}
		}
	}

	/**
	 * One-time import of the old userData/settings.json. SDK values win on
	 * conflict; the legacy file is renamed .migrated once its content is on
	 * disk. The editor part goes through the SettingsManager queue (async), so
	 * on a fresh install that still has legacy data the rename lands a moment
	 * after startup — a failure keeps the file for the next start instead of
	 * losing the value silently.
	 */
	private migrateLegacyFile(): void {
		const filePath = path.join(app.getPath("userData"), "settings.json");
		let legacy: LegacySettingsFile;
		try {
			legacy = JSON.parse(fs.readFileSync(filePath, "utf-8")) as LegacySettingsFile;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[settings] legacy settings.json is unreadable; leaving it in place", err);
			}
			return; // absent (normal) or corrupt (nothing worth migrating)
		}
		const block = readPiPlusSettings();
		const patch: Record<string, unknown> = {};
		const legacyTheme = asTheme(legacy.theme);
		if (legacyTheme !== undefined && asTheme(block.desktopTheme) === undefined) patch.desktopTheme = legacyTheme;
		const legacyWidth = asWidth(legacy.sidebarWidth);
		if (legacyWidth !== undefined && asWidth(block.sidebarWidth) === undefined) patch.sidebarWidth = legacyWidth;
		const legacyMode = asPermissionMode(legacy.defaultPermissionMode);
		if (legacyMode !== undefined && asPermissionMode(block.defaultPermissionMode) === undefined) patch.defaultPermissionMode = legacyMode;
		if (Object.keys(patch).length > 0) {
			updatePiPlusSettings(patch);
			this._theme = patch.desktopTheme as ThemeMode ?? this._theme;
			this._sidebarWidth = patch.sidebarWidth as number ?? this._sidebarWidth;
			this._defaultPermissionMode = patch.defaultPermissionMode as PermissionMode ?? this._defaultPermissionMode;
		}
		const manager = this.editors();
		const legacyEditor = typeof legacy.editor === "string" ? legacy.editor.trim() : "";
		if (legacyEditor !== "" && manager.getExternalEditorSetting() === undefined) {
			this._editor = legacyEditor;
			manager.setExternalEditorCommand(legacyEditor);
			void manager
				.flush()
				.then(() => {
					const errors = manager.drainErrors();
					if (errors.length > 0) throw new Error(errors.map((e) => e.error.message ?? String(e.error)).join("; "));
					this.retireLegacyFile(filePath);
				})
				.catch((err) => console.warn("[settings] editor migration write failed; legacy settings.json kept for the next start", err));
			return;
		}
		this.retireLegacyFile(filePath);
	}

	private retireLegacyFile(filePath: string): void {
		try {
			fs.renameSync(filePath, `${filePath}.migrated`);
		} catch (err) {
			console.warn("[settings] could not retire the legacy settings.json", err);
		}
	}
}
