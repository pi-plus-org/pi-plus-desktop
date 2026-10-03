#!/usr/bin/env node
// Dev runner: esbuild --watch + electron. Reloads the renderer on renderer/preload
// rebuilds and restarts electron when the main bundle changes.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build, context } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
	absWorkingDir: root,
	bundle: true,
	sourcemap: "inline",
	logLevel: "warning",
};

const mainTarget = {
	...common,
	entryPoints: ["src/main/index.ts"],
	outfile: "dist/main.js",
	format: "esm",
	platform: "node",
	packages: "external",
};

const preloadTarget = {
	...common,
	entryPoints: ["src/preload/index.ts"],
	outfile: "dist/preload.cjs",
	format: "cjs",
	platform: "node",
	external: ["electron"],
};

const rendererTarget = {
	...common,
	entryPoints: ["src/renderer/src/main.ts", { in: "src/renderer/src/settings-app.ts", out: "settings" }],
	outdir: "dist/renderer",
	format: "esm",
	platform: "browser",
};

const rendererHtmlTarget = {
	...common,
	entryPoints: ["src/renderer/index.html", "src/renderer/settings.html"],
	outdir: "dist/renderer",
	format: "esm",
	platform: "browser",
	loader: { ".html": "copy" },
};

let electronProc = null;
let mainReady = false;

function restartElectron() {
	if (electronProc) {
		electronProc.removeAllListeners();
		electronProc.kill("SIGTERM");
		electronProc = null;
	}
	electronProc = spawn("electron", ["."], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
	});
	electronProc.on("exit", (code) => {
		if (mainReady && code !== null && code !== 0) {
			console.log(`[dev] electron exited (${code}); waiting for rebuild…`);
		}
	});
}

	// The main process listens for SIGUSR1 (dev mode) and reloads all windows.
	const rendererCtx = await context({
	...rendererTarget,
	plugins: [
		{
			name: "reload-renderer",
			setup(b) {
				b.onEnd(() => {
					if (electronProc) electronProc.kill("SIGUSR1");
				});
			},
		},
	],
});

const preloadCtx = await context({
	...preloadTarget,
	plugins: [
		{
			name: "reload-on-preload",
			setup(b) {
				b.onEnd(() => {
					if (electronProc) electronProc.kill("SIGUSR1");
				});
			},
		},
	],
});

const mainCtx = await context({
	...mainTarget,
	plugins: [
		{
			name: "restart-electron",
			setup(b) {
				b.onEnd(() => {
					mainReady = true;
					restartElectron();
				});
			},
		},
	],
});

await rendererCtx.watch();
await preloadCtx.watch();
await mainCtx.watch();
const rendererHtmlCtx = await context(rendererHtmlTarget);
await rendererHtmlCtx.watch();
console.log("[dev] watching; electron restarts on main changes, SIGUSR1 reloads windows");

process.on("SIGINT", async () => {
	await Promise.all([rendererCtx.dispose(), preloadCtx.dispose(), mainCtx.dispose(), rendererHtmlCtx.dispose()]);
	if (electronProc) electronProc.kill("SIGTERM");
	process.exit(0);
});
