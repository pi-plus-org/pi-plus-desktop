#!/usr/bin/env node
// Builds main (ESM), preload (CJS for sandbox), and renderer (ESM) bundles with esbuild.
// Usage: node scripts/build.mjs [--watch] [--production]

import { build, context } from "esbuild";
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
	absWorkingDir: root,
	bundle: true,
	sourcemap: production ? false : "inline",
	logLevel: "info",
	define: production ? { "process.env.NODE_ENV": '"production"' } : {},
};

const targets = [
	{
		...common,
		entryPoints: ["src/main/index.ts"],
		outfile: "dist/main.js",
		format: "esm",
		platform: "node",
		// The SDK and its native-adjacent externals must load from node_modules at runtime.
		packages: "external",
	},
	{
		...common,
		entryPoints: ["src/preload/index.ts"],
		outfile: "dist/preload.cjs",
		format: "cjs",
		platform: "node",
		external: ["electron"],
	},
	{
		...common,
		entryPoints: ["src/renderer/src/main.ts", { in: "src/renderer/src/settings-app.ts", out: "settings" }],
		outdir: "dist/renderer",
		format: "esm",
		platform: "browser",
	},
	{
		...common,
		entryPoints: ["src/renderer/index.html", "src/renderer/settings.html"],
		outdir: "dist/renderer",
		format: "esm",
		platform: "browser",
		loader: { ".html": "copy" },
	},
];

if (watch) {
	const ctxs = await Promise.all(
		targets.map((t) =>
			context(t).then((c) => {
				void c.watch();
				return c;
			}),
		),
	);
	process.on("SIGINT", () => {
		for (const c of ctxs) void c.dispose();
		process.exit(0);
	});
	console.log("[build] watching for changes…");
} else {
	await Promise.all(targets.map((t) => build(t)));
	// Runtime assets (app icon) resolved relative to dist/main.js.
	await cp(resolve(root, "assets"), resolve(root, "dist/assets"), { recursive: true });
	console.log("[build] done");
}
