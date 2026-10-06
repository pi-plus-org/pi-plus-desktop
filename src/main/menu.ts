/**
 * Native application menu. Profile maintenance and theme management live in
 * the dedicated Settings window (opened via Pi+ > Settings… or Cmd+,), which
 * main creates directly; renderer-targeted actions (New Chat) are delegated
 * via the menu:action push channel to the main window's WebContents.
 */

import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";
import { IPC, type MenuActionDTO } from "../shared/ipc-types.ts";

const isMac = process.platform === "darwin";

export function buildApplicationMenu(
	openSettings: () => void,
	getActionTarget: () => WebContents | undefined,
): void {
	const send = (action: MenuActionDTO): void => {
		const target = getActionTarget();
		if (target && !target.isDestroyed()) target.send(IPC.push.menuAction, action);
	};
	const template: MenuItemConstructorOptions[] = [
		// macOS app menu, expanded from the appMenu role so Settings… can be
		// inserted; the first menu's label renders as the app name.
		...(isMac
			? ([
					{
						label: "Pi+",
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							{ label: "Settings…", accelerator: "Command+,", click: () => openSettings() },
							{ type: "separator" },
							{ role: "services" },
							{ type: "separator" },
							{ role: "hide" },
							{ role: "hideOthers" },
							{ role: "unhide" },
							{ type: "separator" },
							{ role: "quit" },
						],
					},
				] as MenuItemConstructorOptions[])
			: []),
		{
			label: "File",
			submenu: [
				// ⌘N is the "new chat" chord.
				{ label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => send({ action: "new-tab" }) },
				// ⌘W/⌃W closes the active session tab — but only on the main
				// window (the renderer owns tab state). On any other window
				// (Settings…) it behaves like a normal window close. The main
				// window itself keeps a Shift chord for closing.
				{
					label: "Close Tab",
					accelerator: "CmdOrCtrl+W",
					click: (_item, focusedWindow) => {
						// BaseWindow typing on the click arg; tab chrome only
						// exists in our BrowserWindows.
						const win = focusedWindow instanceof BrowserWindow ? focusedWindow : undefined;
						const mainTarget = getActionTarget();
						if (win && win.webContents !== mainTarget) win.close();
						else send({ action: "close-active-tab" });
					},
				},
				// Off-macOS has no app menu; keep Settings reachable from File.
				...(!isMac
					? ([{ label: "Settings", accelerator: "CmdOrCtrl+,", click: () => openSettings() }] as MenuItemConstructorOptions[])
					: []),
				{ type: "separator" },
				{ role: "close", accelerator: "CmdOrCtrl+Shift+W" },
				...(!isMac ? ([{ role: "quit" }] as MenuItemConstructorOptions[]) : []),
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				// No WebContents reload item — ⌘R belongs to the history list;
				// a renderer reload stays available via DevTools.
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", click: () => send({ action: "prev-tab" }) },
				{ label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", click: () => send({ action: "next-tab" }) },
				{ label: "Toggle History", accelerator: "CmdOrCtrl+B", click: () => send({ action: "toggle-sidebar" }) },
			{ label: "Toggle File Tree", accelerator: "CmdOrCtrl+Alt+B", click: () => send({ action: "toggle-filetree" }) },
				{ label: "Reload History", accelerator: "CmdOrCtrl+R", click: () => send({ action: "reload-history" }) },
				{ label: "Edit Draft in External Editor", accelerator: "CmdOrCtrl+Alt+E", click: () => send({ action: "edit-externally" }) },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
