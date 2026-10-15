/**
 * Open external links in a NEW tab of the default browser.
 *
 * `shell.openExternal()` hands the URL to LaunchServices and leaves the
 * "new tab vs. replace the current tab" decision to the browser — in
 * practice an already-running browser often reuses its active tab. On macOS
 * we can take that decision back by scripting the browser directly
 * (`osascript`): every Safari/Chromium-family browser opens `open location`
 * URLs in a fresh tab of the front window. Anything we cannot script
 * (Firefox, unknown handlers, disabled Automation permission, non-macOS
 * platforms) falls back to plain `shell.openExternal`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shell } from "electron";

const execFileAsync = promisify(execFile);

/** bundle id -> AppleScript application name (only browsers honoring `open location`). */
const SCRIPTABLE_BROWSERS: Record<string, string> = {
	"com.apple.safari": "Safari",
	"com.google.chrome": "Google Chrome",
	"com.google.chrome.canary": "Google Chrome Canary",
	"com.microsoft.edgemac": "Microsoft Edge",
	"com.brave.browser": "Brave Browser",
	"com.vivaldi.vivaldi": "Vivaldi",
	"com.operasoftware.opera": "Opera",
	"com.chromium.nanos": "Chromium",
	"org.chromium.chromium": "Chromium",
};

let browserName: string | undefined;
let resolved = false;

/** Ask LaunchServices (via the AppKit bridge — sub-second, unlike a swift
 * compile) which app owns https:, mapped to its AppleScript name. */
async function defaultBrowserName(): Promise<string | undefined> {
	if (resolved) return browserName;
	resolved = true;
	try {
		const { stdout } = await execFileAsync(
			"osascript",
			[
				"-l",
				"JavaScript",
				'-e',
				'ObjC.import("AppKit");ObjC.import("Foundation");var u=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com/"));var b=$.NSBundle.bundleWithPath(ObjC.unwrap(u.path));b?ObjC.unwrap(b.bundleIdentifier):""',
			],
			{ timeout: 10_000 },
		);
		const bundleId = stdout.trim().toLowerCase();
		browserName = SCRIPTABLE_BROWSERS[bundleId];
	} catch {
		// Probe failed (headless, stripped OS): fall back to openExternal.
		browserName = undefined;
	}
	return browserName;
}

function appleScriptQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Open an http(s) URL in a new tab of the default browser.
 * Returns true when the browser was scripted (or openExternal succeeded as
 * the fallback path); false only when nothing worked.
 */
export async function openInNewTab(url: string): Promise<boolean> {
	if (process.platform === "darwin") {
		const name = await defaultBrowserName();
		if (name) {
			try {
				// `activate` first so the new tab lands in the visible window,
				// then `open location` which every Safari/Chromium browser
				// handles by creating a tab (never by replacing one).
				await execFileAsync("osascript", [
					"-e",
					`tell application ${appleScriptQuote(name)} to activate`,
					"-e",
					`tell application ${appleScriptQuote(name)} to open location ${appleScriptQuote(url)}`,
				], { timeout: 15_000 });
				return true;
			} catch {
				// Automation permission denied / browser not scriptable:
				// fall through to the LaunchServices path.
			}
		}
	}
	try {
		await shell.openExternal(url);
		return true;
	} catch {
		return false;
	}
}
