/**
 * Persisted app-level settings (theme, external editor), stored in a small
 * JSON file under userData. Tolerates a missing or corrupt file by falling
 * back to defaults; writes go through a same-dir tmp + rename like profiles.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ThemeMode } from "../shared/ipc-types.ts";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

interface SettingsFile {
	theme?: unknown;
	editor?: unknown;
	sidebarWidth?: unknown;
}

export class AppSettings {
	theme: ThemeMode = "system";
	/** Editor command line for the composer's external-edit button ("" = $VISUAL/$EDITOR). */
	editor = "";
	/** History panel width, drag-resized in the renderer (CSS clamps applied there). */
	sidebarWidth = 260;

	private get filePath(): string {
		return path.join(app.getPath("userData"), "settings.json");
	}

	load(): void {
		let data: SettingsFile;
		try {
			data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as SettingsFile;
		} catch {
			return; // absent or corrupt — keep defaults
		}
		if (typeof data.theme === "string" && THEME_MODES.includes(data.theme as ThemeMode)) {
			this.theme = data.theme as ThemeMode;
		}
		if (typeof data.editor === "string") this.editor = data.editor;
		if (typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth)) this.sidebarWidth = data.sidebarWidth;
	}

	save(): void {
		const filePath = this.filePath;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp-${process.pid}`;
		try {
			fs.writeFileSync(tmpPath, JSON.stringify({ theme: this.theme, editor: this.editor, sidebarWidth: this.sidebarWidth }, null, 2) + "\n");
			fs.renameSync(tmpPath, filePath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	}
}
