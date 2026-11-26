// The desktop's draw_diagram override: a session customTool that replaces the
// SDK's pi-plus-diagram node-edge tool (customTools are applied after
// extension tools in the session registry, so the same name wins — the
// extension factory list itself cannot shadow it, first registration wins
// there). The model authors free-form HTML/SVG; the chat renders the result
// in a static sandboxed iframe (see diagram-view.ts). The details shape
// ({title?, html, htmlPath?}) is lifted into DiagramCardDTO by
// session-sanitize.ts — keep the two in sync.
import "./sdk-shim.ts";
import { Type, type Static } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// defineTool's AnyToolDefinition intersection is what makes the typed tool
// assignable to CreateAgentSessionOptions.customTools (ToolDefinition's
// renderer slots are contravariant in the params type, so the plain generic
// never is). SDK value import stays dynamic: static ones hoist above the shim.
const { defineTool } = await import("pi-plus-sdk");

/** Upper bound for one diagram's markup; guards transcript bloat. */
const MAX_HTML_BYTES = 256 * 1024;

const htmlDiagramSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short diagram title" })),
	html: Type.String({
		description:
			"Self-contained HTML markup for the diagram: inline SVG and/or styled elements with an inline <style> block. No scripts, no external URLs/images/fonts. White/light background, dark strokes.",
	}),
	file: Type.Optional(
		Type.String({
			description:
				"Optional path: also write the diagram as a standalone HTML document there",
		}),
	),
});

type HtmlDiagramInput = Static<typeof htmlDiagramSchema>;

export interface HtmlDiagramDetails {
	title?: string;
	html: string;
	htmlPath?: string;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Wrap a bare fragment into a viewable document for the optional file write. */
function standaloneDocument(title: string, html: string): string {
	if (/<html[\s>]/i.test(html)) return html;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; padding: 24px; background: #ffffff; color: #1f2430; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; justify-content: center; }
</style>
</head>
<body>
${html}
</body>
</html>
`;
}

export function createHtmlDiagramTool(): ReturnType<typeof defineTool> {
	return defineTool({
		name: "draw_diagram",
		label: "Draw Diagram",
		description:
			"Draw a diagram rendered as HTML inline in the chat: flowcharts, dependency graphs, architecture sketches, ER diagrams, sequence diagrams, state machines, timelines, UI mockups. The markup renders in a static sandbox: no scripts, no external resources. Pass file to also save a standalone HTML document. Skip for trivial two-box sketches you can express in a sentence.",
		promptSnippet:
			"Draw a diagram as inline HTML (flowchart, architecture, ER, sequence, mockup)",
		promptGuidelines: [
			"Use draw_diagram whenever the user asks to draw, diagram, or visualize components, flows, or dependencies.",
			"Author self-contained HTML: inline SVG and/or styled elements with an inline <style> block. Never use <script>, external URLs, images, or web fonts — the sandbox blocks them.",
			"Size for a chat column up to ~700px wide. Use a white or light background with dark strokes so the diagram reads on both light and dark app themes.",
			"Keep diagrams readable: under ~20 nodes for graph layouts, short labels, generous spacing.",
			'Pass "file" only when the user wants a saved HTML document; the inline chat view is enough for conversation.',
		],
		parameters: htmlDiagramSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: HtmlDiagramInput, _signal, _onUpdate, ctx) {
			const html = params.html.trim();
			if (!html) throw new Error("draw_diagram: html must not be empty");
			if (html.length > MAX_HTML_BYTES) {
				throw new Error(
					`draw_diagram: html is ${html.length} bytes; keep it under ${MAX_HTML_BYTES}`,
				);
			}
			const title = params.title?.trim() || undefined;
			const details: HtmlDiagramDetails = { html };
			if (title) details.title = title;

			let text = `Drew diagram${title ? ` "${title}"` : ""} (${html.length} bytes of HTML), rendered inline in the chat.`;
			if (params.file) {
				const htmlPath = resolve(ctx.cwd, params.file);
				await mkdir(dirname(htmlPath), { recursive: true });
				await writeFile(htmlPath, standaloneDocument(title ?? "Diagram", html), "utf8");
				details.htmlPath = htmlPath;
				text += ` Standalone HTML written to ${htmlPath}.`;
			}
			return { content: [{ type: "text", text }], details };
		},
	});
}
