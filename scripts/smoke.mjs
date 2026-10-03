#!/usr/bin/env node
/**
 * SDK smoke test (no Electron): create a plus runtime in a temp dir, send a
 * prompt, and assert a finalized assistant message arrives, then round-trip
 * the runtime-level capabilities the desktop app relies on (clone in place,
 * /cd relocation, rename, context usage, skills). Requires a configured
 * provider (auth.json or env API key); prints SKIP when no model is available
 * instead of failing.
 *
 * Usage: node scripts/smoke.mjs
 */

process.env.PI_SKIP_VERSION_CHECK = "1";

// Same shim as src/main/sdk-shim.ts: the SDK's ESM bundle needs a global require.
import { createRequire } from "node:module";
if (typeof globalThis.require === "undefined") {
	globalThis.require = createRequire(import.meta.url);
}

const { existsSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const sdk = await import("pi-plus-sdk");
const { createPlusAgentSessionRuntime } = sdk;

function assert(cond, message) {
	if (!cond) {
		console.error(`[smoke] FAIL: ${message}`);
		process.exit(1);
	}
}

const cwd = mkdtempSync(join(tmpdir(), "pi-plus-smoke-"));
console.log(`[smoke] cwd: ${cwd}`);

// Bind-driven runtime (no ui handlers — headless), same construction the
// desktop SessionHost uses per tab (minus dialogs/profile agent dirs).
const runtime = await createPlusAgentSessionRuntime({
	cwd,
	excludeTools: ["subagent"],
});

if (runtime.modelFallbackMessage) {
	console.log(`[smoke] SKIP: no model/auth configured — ${runtime.modelFallbackMessage}`);
	await runtime.dispose();
	process.exit(0);
}

// The default picked by the SDK may use a provider whose env token is not
// actually valid for direct API access (e.g. ANTHROPIC_AUTH_TOKEN routed via
// a third-party base URL). Prefer an explicitly requested provider, then
// whatever is already selected.
// Usage: node scripts/smoke.mjs [provider]
const preferredProvider = process.argv[2] ?? "kimi-coding";
let session = runtime.session;
if (session.model.provider !== preferredProvider) {
	const modelRuntime = session.modelRuntime;
	for (const model of modelRuntime.getModels(preferredProvider)) {
		try {
			await session.setModel(model);
			break;
		} catch {
			// try the next model
		}
	}
}
console.log(`[smoke] model: ${session.model.provider}/${session.model.id}`);

const done = new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("timed out waiting for assistant message")), 90_000);
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			clearTimeout(timeout);
			resolve(event.message);
		}
	});
});

await session.prompt("Reply with exactly: ok");

const message = await done;
if (message.errorMessage || message.stopReason === "error") {
	console.log(`[smoke] SKIP: model call failed (environment/auth issue): ${message.errorMessage}`);
	await runtime.dispose();
	process.exit(2);
}
const text = message.content
	.filter((b) => b.type === "text")
	.map((b) => b.text)
	.join("");
console.log(`[smoke] assistant reply: ${JSON.stringify(text.slice(0, 120))}`);
assert(text.trim(), "empty assistant reply");

// --- capabilities the desktop tabs menu / toolbar exercise ---------------

const usage = session.getContextUsage();
console.log(
	`[smoke] context usage: ${usage ? `${usage.tokens ?? "?"}/${usage.contextWindow} (${usage.percent === null ? "?" : usage.percent.toFixed(1)}%)` : "unavailable"}`,
);

const skills = session.resourceLoader.getSkills().skills;
console.log(`[smoke] skills discovered: ${skills.length}`);

session.setSessionName("smoke session");
assert(session.sessionName === "smoke session", "setSessionName did not stick");

// Clone = fork at the leaf, in place (same history, new file, same session dir).
const originalFile = session.sessionFile;
assert(originalFile && existsSync(originalFile), "session file missing after first reply");
const beforeCount = session.messages.length;
const clone = await runtime.fork(session.sessionManager.getLeafId(), { position: "at" });
assert(!clone.cancelled, "clone fork was cancelled");
session = runtime.session;
assert(session.sessionFile !== originalFile, "clone reused the original transcript");
assert(session.messages.length === beforeCount, "clone lost history");
console.log(`[smoke] clone ok: ${session.sessionFile}`);

// /cd relocates the session to the new project's default session dir.
const cloneFile = session.sessionFile;
const targetCwd = mkdtempSync(join(tmpdir(), "pi-plus-smoke-target-"));
await session.prompt(`/cd ${targetCwd}`, { streamingBehavior: "followUp" });
assert(runtime.cwd === targetCwd, `cd did not move cwd (still ${runtime.cwd})`);
assert(!existsSync(cloneFile), "cd left the old transcript file behind");
console.log(`[smoke] cd ok: moved to ${targetCwd}, transcript ${runtime.session.sessionFile}`);

console.log("[smoke] PASS");
await runtime.dispose();
process.exit(0);
