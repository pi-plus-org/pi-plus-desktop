/**
 * about-app.ts — standalone About window (app menu → About Pi+).
 *
 * A small read-only version form: desktop app version, pi-plus-sdk version
 * and the Electron/Node runtimes. The main process passes the values in the
 * loadFile query string, so this page needs no preload bridge or IPC.
 */
import "../styles.css";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const params = new URLSearchParams(location.search);

const fields: Array<[string, string]> = [
	["Desktop version", params.get("desktop") ?? "—"],
	["pi-plus-sdk version", params.get("sdk") ?? "—"],
	["Electron", params.get("electron") ?? "—"],
	["Node.js", params.get("node") ?? "—"],
];

const form = el("form", "about-form");
form.append(el("h1", "about-title", "Pi+ Desktop"));
for (const [label, value] of fields) {
	const row = el("label", "about-row");
	const input = document.createElement("input");
	input.className = "about-value";
	input.value = value;
	input.readOnly = true;
	// Read-only: focus/typing would suggest editing; clicking only selects.
	input.tabIndex = -1;
	row.append(el("span", "about-label", label), input);
	form.append(row);
}

document.getElementById("about-root")!.append(form);
