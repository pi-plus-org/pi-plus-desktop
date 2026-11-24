// Visual renderer for the SDK's hidden `pi-plus-diagram` factory results
// (see `session-sanitize.ts` — the tool result's `details` are lifted into a
// `DiagramCardDTO` on both the live event and the resumed-transcript DTO).
//
// The diagram is rendered as an inline figure embedded in the assistant's
// response (not a tool card): the SDK-computed SVG is the body, with a small
// caption (title + Open-HTML link) underneath. When no SVG renderer is wired
// (or layout failed main-side) the tool's own ASCII fills the frame instead —
// same layout engine, so the two never disagree.

import type { DiagramCardDTO } from "../../shared/ipc-types.js";

function el(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function renderDiagramEmbed(diagram: DiagramCardDTO): HTMLElement {
	const figure = el("figure", "diagram-embed");
	if (diagram.svg) {
		const frame = el("div", "diagram-embed-frame");
		frame.innerHTML = diagram.svg;
		figure.append(frame);
	} else {
		const pre = el("pre", "diagram-ascii diagram-embed-frame");
		pre.textContent = diagram.ascii;
		figure.append(pre);
	}
	if (diagram.title || diagram.htmlPath) {
		const cap = el("figcaption", "diagram-embed-cap");
		if (diagram.title) cap.append(el("span", "diagram-embed-title", `⛁ ${diagram.title}`));
		if (diagram.htmlPath) {
			const open = el("button", "diagram-open", "Open HTML ↗") as HTMLButtonElement;
			open.type = "button";
			open.title = diagram.htmlPath;
			open.addEventListener("click", async () => {
				try {
					const err = await window.pi.openPath(diagram.htmlPath!);
					if (err) window.dispatchEvent(new CustomEvent("pi:notify", { detail: err }));
				} catch (e) {
					window.dispatchEvent(new CustomEvent("pi:notify", { detail: String(e) }));
				}
			});
			cap.append(open);
		}
		figure.append(cap);
	}
	return figure;
}
