import { app } from "electron";
console.error("module loaded");
await new Promise((r) => app.on("ready", r));
console.error("READY (via await)");
app.exit(0);
