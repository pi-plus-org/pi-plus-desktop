/**
 * pi-plus-sdk's published ESM bundle keeps CJS require() calls for bundled
 * dependencies (cross-spawn etc.), guarded by `typeof require < "u"`. Under a
 * pure ESM host (Electron main, plain node) there is no global require, so we
 * install one before the SDK module evaluates. Import this module BEFORE any
 * value import of "pi-plus-sdk".
 */

import { createRequire } from "node:module";

const g = globalThis as { require?: NodeJS.Require };

if (typeof g.require === "undefined") {
	g.require = createRequire(import.meta.url);
}
