/**
 * Finds and rewrites `mermaid` code blocks in a note's text.
 *
 * A block that's being edited as a canvas carries a comment line with a short
 * link id (`%% CanvasFlow link ab12cd34 ...`). Mermaid ignores comments, so the
 * chart draws the same; the id is how the block and its canvas find each other
 * again, even after either file is renamed or the note is edited around it.
 */

export interface MermaidBlock {
  /** Line numbers (0-based) of the opening and closing fence. */
  start: number;
  end: number;
  /** What comes before the fence on its line: indentation, or `> ` in a callout or quote. Repeated on every line of the block. */
  prefix: string;
  /** The Mermaid code, without the link line. */
  code: string;
  linkId: string | null;
}

const OPEN = /^([ \t>]*)(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i;
const LINK = /^\s*%%\s*canvasflow\s+link\s+([0-9a-f]{8})\b/i;

export function linkLine(id: string): string {
  return `%% CanvasFlow link ${id} (keeps this chart tied to its canvas)`;
}

export function newLinkId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

function stripPrefix(line: string, prefix: string): string {
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  // A blank line in a callout is often just ">" with no space after it.
  const bare = prefix.replace(/[ \t]+$/, "");
  return bare && line.startsWith(bare) ? line.slice(bare.length) : line;
}

export function findMermaidBlocks(text: string): MermaidBlock[] {
  const lines = text.split("\n");
  const blocks: MermaidBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i].replace(/\r$/, ""));
    if (!open) continue;
    const prefix = open[1], fence = open[2];
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const inner = stripPrefix(lines[j].replace(/\r$/, ""), prefix).trim();
      if (inner.length >= fence.length && inner === fence[0].repeat(inner.length)) { end = j; break; }
    }
    if (end < 0) break;   // an unclosed block runs to the end of the note; leave it alone

    let linkId: string | null = null;
    const code: string[] = [];
    for (let j = i + 1; j < end; j++) {
      const line = stripPrefix(lines[j].replace(/\r$/, ""), prefix);
      const link = LINK.exec(line);
      if (link && !linkId) linkId = link[1].toLowerCase();
      else code.push(line);
    }
    blocks.push({ start: i, end, prefix, code: code.join("\n"), linkId });
    i = end;
  }
  return blocks;
}

/** The block that `line` is in (fences included), or the first one that starts within `through` lines after it. */
export function blockAtLine(blocks: MermaidBlock[], line: number, through = line): MermaidBlock | null {
  return blocks.find(b => line >= b.start && line <= b.end)
    ?? blocks.find(b => b.start >= line && b.start <= through)
    ?? null;
}

/** The note's text with `block` rewritten to hold `code` and the link line. The fences stay as they are. */
export function writeBlock(text: string, block: MermaidBlock, code: string, linkId: string | null): string {
  const lines = text.split("\n");
  const body = [...(linkId ? [linkLine(linkId)] : []), ...code.replace(/\s+$/, "").split("\n")]
    .map(line => (line.length ? block.prefix + line : block.prefix.replace(/[ \t]+$/, "")));
  lines.splice(block.start + 1, block.end - block.start - 1, ...body);
  return lines.join("\n");
}
