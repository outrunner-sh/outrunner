/**
 * A session's markdown as Atlassian's document format: replies are the main thing people
 * read in Jira. Headings, fenced code, lists, quotes, rules, bold, italic, inline code and
 * links. Nested lists come out flat, and anything else stays as written.
 */

type Node = Record<string, unknown>;

const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*(?=\S)([^*\n]+?)(?<=\S)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)\]]+)/g;

function text(value: string, mark?: Node): Node {
  return mark ? { type: "text", text: value, marks: [mark] } : { type: "text", text: value };
}

function inline(line: string): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > at) nodes.push(text(line.slice(at, match.index)));
    at = match.index + match[0].length;
    const [, code, bold, bold2, em, em2, label, href, bare] = match;
    if (code) nodes.push(text(code, { type: "code" }));
    else if (bold || bold2) nodes.push(text((bold ?? bold2) as string, { type: "strong" }));
    else if (em || em2) nodes.push(text((em ?? em2) as string, { type: "em" }));
    else if (label && href) nodes.push(text(label, { type: "link", attrs: { href } }));
    else if (bare) {
      // A sentence's end isn't part of its link.
      const url = bare.replace(/[.,;:!?]+$/, "");
      nodes.push(text(url, { type: "link", attrs: { href: url } }));
      at -= bare.length - url.length;
    }
  }
  if (at < line.length) nodes.push(text(line.slice(at)));
  return nodes;
}

const paragraph = (line: string): Node => ({ type: "paragraph", content: inline(line) });
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(?:\d+)[.)]\s+(.*)$/;
const NUMBER = /^\s*(\d+)/;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Text as a document. An unclosed fence runs to the end, as markdown has it. */
export function toAdf(markdown: string): unknown {
  const content: Node[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) continue;

    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !FENCE.test(lines[i] as string); i++) code.push(lines[i] as string);
      const body = code.join("\n");
      content.push({ type: "codeBlock", ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: body ? [text(body)] : [] });
      continue;
    }
    if (RULE.test(line)) {
      content.push({ type: "rule" });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      content.push({ type: "heading", attrs: { level: (heading[1] as string).length }, content: inline(heading[2] as string) });
      continue;
    }
    const list = BULLET.test(line) ? { kind: "bulletList", item: BULLET } : NUMBERED.test(line) ? { kind: "orderedList", item: NUMBERED } : null;
    if (list) {
      const items: Node[] = [];
      for (; i < lines.length; i++) {
        const entry = (lines[i] as string).match(list.item);
        if (!entry) break;
        items.push({ type: "listItem", content: [paragraph(entry[1] as string)] });
      }
      i -= 1;
      // A blank line between items makes another list: it goes on counting from where it is.
      const order = list.kind === "orderedList" ? Number(line.match(NUMBER)?.[1] ?? 1) : 1;
      content.push({ type: list.kind, ...(order > 1 ? { attrs: { order } } : {}), content: items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: Node[] = [];
      for (; i < lines.length; i++) {
        const entry = (lines[i] as string).match(QUOTE);
        if (!entry) break;
        if (entry[1]) quoted.push(paragraph(entry[1]));
      }
      i -= 1;
      if (quoted.length) content.push({ type: "blockquote", content: quoted });
      continue;
    }
    content.push(paragraph(line));
  }
  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}
