#!/usr/bin/env node
// Renders assets/icon.svg to a 1024x1024 PNG (assets/icon.png) using this
// project's own Electron — no external rasterizer needed.
// Usage: ./node_modules/.bin/electron scripts/make-icon.mjs
//
// Note: run via the electron binary (not `node`): the script IS the main
// process. Must use the `ready` callback — top-level await on the entry module
// makes Electron fire `ready` before the listener is attached.
// Rasterizes via a <canvas> in the renderer (drawImage of the SVG), which does
// not depend on window compositing.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 1024;
const log = (msg) => console.error(`[icon] ${msg}`); // stderr is unbuffered

setTimeout(() => { log("TIMEOUT — aborting"); process.exit(1); }, 30_000);

app.on("ready", async () => {
  log("app ready");

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: -4000,
    y: 0,
    show: false, // shown briefly below so the renderer actually runs
    webPreferences: { sandbox: true },
  });
  log("window created");

  win.once("ready-to-show", () => log("ready-to-show"));
  await win.loadURL("data:text/html,<body></body>");
  win.show(); // offscreen: paints/runs without being visible
  log("blank page loaded");

  const svgText = readFileSync(join(root, "assets/icon.svg"), "utf8");
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svgText).toString("base64");

  const pngDataUrl = await win.webContents.executeJavaScript(
    `(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ${SIZE};
      canvas.getContext("2d").drawImage(img, 0, 0, ${SIZE}, ${SIZE});
      return canvas.toDataURL("image/png");
    })()`,
    true,
  );
  log("rasterized");

  const base64 = pngDataUrl.split(",")[1];
  writeFileSync(join(root, "assets/icon.png"), Buffer.from(base64, "base64"));
  log(`wrote assets/icon.png (${base64.length} base64 chars)`);

  win.destroy();
  app.exit(0);
});
