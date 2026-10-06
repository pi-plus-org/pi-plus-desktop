/**
 * Colorful diff rendering for tool results, mirroring the pi CLI's terminal
 * diff (coding-agent `components/diff.ts`): green added lines, red removed
 * lines, dim context, and emphasis on the changed span of a lone -/+ pair
 * (a single modified line).
 *
 * Input grammar (the SDK's display diff, see core/tools/edit-diff.ts):
 *   `-NN content` / `+NN content` / ` NN content` / `    ...`
 * All content is inserted via textContent — never innerHTML.
 */

const DIFF_LINE_RE = /^([+-\s])(\s*\d*)\s(.*)$/;

interface ParsedDiffLine {
	prefix: "+" | "-" | " ";
	lineNum: string;
	content: string;
}

function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = DIFF_LINE_RE.exec(line);
	const prefix = match?.[1];
	if (!prefix || (prefix !== "+" && prefix !== "-" && prefix !== " ")) return null;
	return { prefix, lineNum: (match[2] ?? "").trim(), content: match[3] ?? "" };
}

function row(kind: string, sign: string, lineNum: string): HTMLElement {
	const node = document.createElement("div");
	node.className = `diff-line ${kind}`;
	const num = document.createElement("span");
	num.className = "diff-ln";
	num.textContent = lineNum;
	const s = document.createElement("span");
	s.className = "diff-sign";
	s.textContent = sign;
	const text = document.createElement("span");
	text.className = "diff-text";
	node.append(num, s, text);
	return node;
}

/** Fill a row's text span, wrapping the changed middle in <mark> parts. */
function setTextWithEmphasis(textNode: HTMLElement, before: string, changed: string, after: string): void {
	textNode.textContent = before;
	if (changed) {
		const mark = document.createElement("mark");
		mark.textContent = changed;
		textNode.append(mark);
	}
	if (after) textNode.append(after);
}

/** Longest common prefix/suffix character diff — the CLI's inverse-token rule. */
function renderModifiedPair(container: HTMLElement, removed: ParsedDiffLine, added: ParsedDiffLine): void {
	const oldText = removed.content;
	const newText = added.content;
	const maxCommon = Math.min(oldText.length, newText.length);
	let prefix = 0;
	while (prefix < maxCommon && oldText[prefix] === newText[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < maxCommon - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}
	const delRow = row("diff-del", "-", removed.lineNum);
	const addRow = row("diff-add", "+", added.lineNum);
	setTextWithEmphasis(
		delRow.lastElementChild as HTMLElement,
		oldText.slice(0, prefix),
		oldText.slice(prefix, oldText.length - suffix),
		oldText.slice(oldText.length - suffix),
	);
	setTextWithEmphasis(
		addRow.lastElementChild as HTMLElement,
		newText.slice(0, prefix),
		newText.slice(prefix, newText.length - suffix),
		newText.slice(newText.length - suffix),
	);
	container.append(delRow, addRow);
}

/** Render an SDK display diff as colored, line-numbered rows. */
export function renderDiffView(diffText: string): HTMLElement {
	const container = document.createElement("div");
	container.className = "diff-view";
	const lines = diffText.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const parsed = parseDiffLine(line);
		if (!parsed) {
			// Unparseable (hunk headers, truncation markers): plain context row.
			const ctx = row("diff-ctx", " ", "");
			(ctx.lastElementChild as HTMLElement).textContent = line;
			container.append(ctx);
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removed: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i] ?? "");
				if (!p || p.prefix !== "-") break;
				removed.push(p);
				i++;
			}
			const added: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i] ?? "");
				if (!p || p.prefix !== "+") break;
				added.push(p);
				i++;
			}
			const removedOnly = removed.length === 1 ? removed[0] : undefined;
			const addedOnly = added.length === 1 ? added[0] : undefined;
			if (removedOnly && addedOnly) {
				renderModifiedPair(container, removedOnly, addedOnly);
			} else {
				for (const r of removed) {
					const del = row("diff-del", "-", r.lineNum);
					(del.lastElementChild as HTMLElement).textContent = r.content;
					container.append(del);
				}
				for (const a of added) {
					const add = row("diff-add", "+", a.lineNum);
					(add.lastElementChild as HTMLElement).textContent = a.content;
					container.append(add);
				}
			}
			continue;
		}
		if (parsed.prefix === "+") {
			const add = row("diff-add", "+", parsed.lineNum);
			(add.lastElementChild as HTMLElement).textContent = parsed.content;
			container.append(add);
			i++;
			continue;
		}
		// Context line or hunk separator (`...` with a blank line number).
		const sep = !parsed.lineNum && parsed.content.trim() === "...";
		const ctx = row(sep ? "diff-sep" : "diff-ctx", " ", parsed.lineNum);
		(ctx.lastElementChild as HTMLElement).textContent = parsed.content;
		container.append(ctx);
		i++;
	}
	return container;
}

/** Render whole-file content as an all-added view (the write tool's case). */
export function renderAddedFile(content: string, cap = 200): HTMLElement {
	const container = document.createElement("div");
	container.className = "diff-view";
	const lines = content.split("\n");
	// A trailing newline shows up as one empty final element; drop it.
	if (content.endsWith("\n")) lines.pop();
	const shown = Math.min(lines.length, cap);
	for (let n = 0; n < shown; n++) {
		const add = row("diff-add", "+", String(n + 1));
		(add.lastElementChild as HTMLElement).textContent = lines[n] ?? "";
		container.append(add);
	}
	if (lines.length > shown) {
		const more = row("diff-sep", " ", "");
		(more.lastElementChild as HTMLElement).textContent = `… +${lines.length - shown} more lines`;
		container.append(more);
	}
	return container;
}
