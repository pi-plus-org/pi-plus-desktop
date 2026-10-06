/**
 * Preload: exposes the typed PiApi surface on window.pi via contextBridge.
 * Sandboxed (CJS, electron-only imports) — the renderer has no Node access.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type PiApi } from "../shared/ipc-types.ts";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
	const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

const api: PiApi = {
	createTab: (opts) => ipcRenderer.invoke(IPC.invoke.createTab, opts),
	ensureSession: (tabId, resumePath) => ipcRenderer.invoke(IPC.invoke.ensureSession, tabId, resumePath),
	prompt: (tabId, text, attachments, mode) => ipcRenderer.invoke(IPC.invoke.prompt, tabId, text, attachments, mode),
	abort: (tabId) => ipcRenderer.invoke(IPC.invoke.abort, tabId),
	closeTab: (tabId) => ipcRenderer.invoke(IPC.invoke.closeTab, tabId),
	setTabProfile: (tabId, profileName) => ipcRenderer.invoke(IPC.invoke.setTabProfile, tabId, profileName),
	listSessions: () => ipcRenderer.invoke(IPC.invoke.listSessions),
	searchSessions: (query) => ipcRenderer.invoke(IPC.invoke.searchSessions, query),
	deleteSession: (path) => ipcRenderer.invoke(IPC.invoke.deleteSession, path),
	setModel: (tabId, modelRef) => ipcRenderer.invoke(IPC.invoke.setModel, tabId, modelRef),
	setThinkingLevel: (tabId, level) => ipcRenderer.invoke(IPC.invoke.setThinkingLevel, tabId, level),
	compact: (tabId, customInstructions) => ipcRenderer.invoke(IPC.invoke.compact, tabId, customInstructions),
	abortCompaction: (tabId) => ipcRenderer.invoke(IPC.invoke.abortCompaction, tabId),
	setAutoCompaction: (tabId, enabled) => ipcRenderer.invoke(IPC.invoke.setAutoCompaction, tabId, enabled),
	clone: (tabId) => ipcRenderer.invoke(IPC.invoke.clone, tabId),
	cd: (tabId, dirPath) => ipcRenderer.invoke(IPC.invoke.cd, tabId, dirPath),
	listForkTargets: (tabId) => ipcRenderer.invoke(IPC.invoke.listForkTargets, tabId),
	forkFromMessage: (tabId, entryId) => ipcRenderer.invoke(IPC.invoke.forkFromMessage, tabId, entryId),
	rewind: (tabId, entryId, summarize) => ipcRenderer.invoke(IPC.invoke.rewind, tabId, entryId, summarize),
	renameSession: (tabId, name) => ipcRenderer.invoke(IPC.invoke.renameSession, tabId, name),
	clearQueue: (tabId) => ipcRenderer.invoke(IPC.invoke.clearQueue, tabId),
	listSkills: (tabId) => ipcRenderer.invoke(IPC.invoke.listSkills, tabId),
	listCommands: (tabId) => ipcRenderer.invoke(IPC.invoke.listCommands, tabId),
	listModels: (tabId) => ipcRenderer.invoke(IPC.invoke.listModels, tabId),
	setPermissionMode: (tabId, mode) => ipcRenderer.invoke(IPC.invoke.setPermissionMode, tabId, mode),
	listProfiles: () => ipcRenderer.invoke(IPC.invoke.listProfiles),
	createProfile: (name, profile) => ipcRenderer.invoke(IPC.invoke.createProfile, name, profile),
	updateProfile: (name, profile) => ipcRenderer.invoke(IPC.invoke.updateProfile, name, profile),
	removeProfile: (name) => ipcRenderer.invoke(IPC.invoke.removeProfile, name),
	renameProfile: (oldName, newName) => ipcRenderer.invoke(IPC.invoke.renameProfile, oldName, newName),
	setDefaultProfile: (name) => ipcRenderer.invoke(IPC.invoke.setDefaultProfile, name),
	setProfileDefaultModel: (name, model) => ipcRenderer.invoke(IPC.invoke.setDefaultModel, name, model),
	addProfileModel: (name, model) => ipcRenderer.invoke(IPC.invoke.addModel, name, model),
	removeProfileModel: (name, model) => ipcRenderer.invoke(IPC.invoke.removeModel, name, model),
	loginProfile: (name, provider) => ipcRenderer.invoke(IPC.invoke.loginProfile, name, provider),
	abortLogin: (name) => ipcRenderer.invoke(IPC.invoke.abortLogin, name),
	getProfileAuthStatus: (name) => ipcRenderer.invoke(IPC.invoke.authStatus, name),
	cleanProfileDir: (name) => ipcRenderer.invoke(IPC.invoke.cleanProfileDir, name),
	getSettings: () => ipcRenderer.invoke(IPC.invoke.getSettings),
	setTheme: (theme) => ipcRenderer.invoke(IPC.invoke.setTheme, theme),
	setEditor: (command) => ipcRenderer.invoke(IPC.invoke.setEditor, command),
	listEditors: () => ipcRenderer.invoke(IPC.invoke.listEditors),
	setSidebarWidth: (width) => ipcRenderer.invoke(IPC.invoke.setSidebarWidth, width),
	setFiletreeWidth: (width) => ipcRenderer.invoke(IPC.invoke.setFiletreeWidth, width),
	setDefaultPermissionMode: (mode) => ipcRenderer.invoke(IPC.invoke.setDefaultPermissionMode, mode),
	openInEditor: (text) => ipcRenderer.invoke(IPC.invoke.openInEditor, text),
	getCompactionSettings: () => ipcRenderer.invoke(IPC.invoke.getCompaction),
	setCompactionSettings: (patch) => ipcRenderer.invoke(IPC.invoke.setCompaction, patch),
	pickDirectory: () => ipcRenderer.invoke(IPC.invoke.pickDirectory),
	pickFiles: () => ipcRenderer.invoke(IPC.invoke.pickFiles),
	readImage: (path) => ipcRenderer.invoke(IPC.invoke.readImage, path),
	saveAttachment: (name, dataUrl) => ipcRenderer.invoke(IPC.invoke.saveAttachment, name, dataUrl),
	getPathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	listDir: (tabId, subpath, prefix) => ipcRenderer.invoke(IPC.invoke.listDir, tabId, subpath, prefix),
	openPath: (path) => ipcRenderer.invoke(IPC.invoke.openPath, path),
	respondDialog: (requestId, value) => ipcRenderer.send(IPC.invoke.respondDialog, requestId, value),
	respondAuthPrompt: (requestId, value) => ipcRenderer.send(IPC.invoke.respondAuthPrompt, requestId, value),
	onSessionEvent: (cb) => subscribe(IPC.push.sessionEvent, cb),
	onSessionStatus: (cb) => subscribe(IPC.push.sessionStatus, cb),
	onSessionMeta: (cb) => subscribe(IPC.push.sessionMeta, cb),
	onSessionTasks: (cb) => subscribe(IPC.push.sessionTasks, cb),
	onDialogRequest: (cb) => subscribe(IPC.push.dialogRequest, cb),
	onDialogNotify: (cb) => subscribe(IPC.push.dialogNotify, cb),
	onProfilesChanged: (cb) => subscribe(IPC.push.profilesChanged, cb),
	onMenuAction: (cb) => subscribe(IPC.push.menuAction, cb),
	onAuthPrompt: (cb) => subscribe(IPC.push.authPrompt, cb),
	onAuthPromptCancel: (cb) => subscribe(IPC.push.authPromptCancel, cb),
	onAuthNotify: (cb) => subscribe(IPC.push.authNotify, cb),
};

contextBridge.exposeInMainWorld("pi", api);
