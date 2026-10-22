/**
 * Remembers the main window's geometry and page zoom across launches.
 *
 * Both values are desktop chrome, so they live in the `piPlus` block of
 * ~/.pi/agent/settings.json next to the panel widths/folds (AppSettings).
 *
 * Two details shape the design:
 *  - the saved rect is stored as the *normal* bounds (`getNormalBounds()`), so
 *    a quit while maximized/fullscreen still restores the real size, with the
 *    maximized flag remembered separately;
 *  - Electron's `zoomIn`/`zoomOut`/`resetZoom` menu roles change
 *    `webContents.zoomFactor` without emitting anything observable from the
 *    main process, so the factor is *sampled* (a cheap poll plus the same
 *    snapshot hooks) rather than pushed.
 */

import { BrowserWindow, screen } from "electron";
import type { AppSettings, WindowBounds } from "./settings.ts";

/** Coalesce a drag/resize storm into one settings write. */
const SAVE_DEBOUNCE_MS = 400;
/** Menu zoom roles are silent; poll the factor instead of subscribing. */
const ZOOM_POLL_MS = 1200;
/** How much of the window must sit inside a display's work area to restore its position. */
const ON_SCREEN_MARGIN = 60;
/** Floor for a restored size — guards a corrupt/huge shrink, Electron's own min sizes apply after. */
const MIN_RESTORE_SIZE = 200;

type GeometryEvent = "resize" | "move" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen";

/** Constructor-ready rectangle; x/y are omitted when the saved spot is unreachable. */
export interface WindowRect {
	x?: number;
	y?: number;
	width: number;
	height: number;
	/** Set when the remembered position was dropped, so the window opens centered. */
	center?: boolean;
}

/**
 * True when the rectangle still overlaps some display's work area (a unplugged
 * second monitor must not strand the window off-screen).
 */
export function isOnScreen(rect: { x: number; y: number; width: number; height: number }): boolean {
	for (const display of screen.getAllDisplays()) {
		const area = display.workArea;
		const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
		const overlapY = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
		if (overlapX >= ON_SCREEN_MARGIN && overlapY >= ON_SCREEN_MARGIN) return true;
	}
	return false;
}

/**
 * Turn the persisted bounds into BrowserWindow size/position options, falling
 * back to the launch defaults when nothing was saved, the saved numbers are
 * garbage, or the saved position no longer exists on any screen.
 */
export function resolveWindowRect(saved: WindowBounds | null, fallback: { width: number; height: number }): WindowRect {
	if (!saved) return { ...fallback };
	const { x, y, width, height } = saved;
	const numbers = [x, y, width, height];
	if (!numbers.every((n) => Number.isFinite(n))) return { ...fallback };
	if (width < MIN_RESTORE_SIZE || height < MIN_RESTORE_SIZE) return { ...fallback };
	const rect = { x, y, width, height };
	// Keep the size but drop the position when the old spot is gone — the
	// window then opens centered at the remembered size.
	if (!isOnScreen(rect)) return { width, height, center: true };
	return rect;
}

/**
 * Track the window's geometry/zoom and mirror them into settings.
 * Returns a detach function (unused in the app lifecycle; kept for tests).
 */
export function attachWindowState(win: BrowserWindow, settings: AppSettings): () => void {
	let debounce: ReturnType<typeof setTimeout> | null = null;

	const snapshot = (): void => {
		if (win.isDestroyed()) return;
		const normal = win.getNormalBounds();
		settings.windowBounds = {
			x: normal.x,
			y: normal.y,
			width: normal.width,
			height: normal.height,
			maximized: win.isMaximized(),
		};
		if (!win.webContents.isDestroyed()) settings.zoomFactor = win.webContents.getZoomFactor();
		// The chrome keys write synchronously through the SDK store; only the
		// editor key is queued, so a fire-and-forget flush cannot lose them.
		void settings.save().catch((err) => console.warn("[window-state] failed to persist window state", err));
	};

	const schedule = (): void => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = null;
			snapshot();
		}, SAVE_DEBOUNCE_MS);
	};

	const events: GeometryEvent[] = ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"];
	// Electron's d.ts declares one overload per event name, so a union-typed name
	// matches none of them; go through the plain string-keyed emitter form.
	const emitter = win as unknown as { on(name: string, listener: () => void): void; removeListener(name: string, listener: () => void): void };
	for (const event of events) emitter.on(event, schedule);

	// Save the last known geometry/zoom on the way out (the debounced write may
	// still be pending) and stop the poll.
	win.on("close", () => {
		if (debounce) {
			clearTimeout(debounce);
			debounce = null;
		}
		snapshot();
	});

	const poll = setInterval(() => {
		if (win.isDestroyed() || win.webContents.isDestroyed()) return;
		if (win.webContents.getZoomFactor() !== settings.zoomFactor) snapshot();
	}, ZOOM_POLL_MS);
	win.on("closed", () => clearInterval(poll));

	return () => {
		if (debounce) clearTimeout(debounce);
		clearInterval(poll);
		for (const event of events) emitter.removeListener(event, schedule);
	};
}
