/**
 * A small parser for Mermaid flowcharts.
 *
 * Obsidian doesn't expose a Mermaid parser (and from 1.15 it draws Mermaid
 * with its own renderer), so this reads the flowchart syntax itself: nodes and
 * their shapes, lines with arrowheads, styles and labels, subgraphs, and
 * `style`, `classDef`, `class` and `linkStyle`. Other statements (`click`,
 * `direction` inside a subgraph and so on) are skipped. Other chart types
 * (sequence, state, ...) are rejected.
 */

export type FlowDirection = "TD" | "BT" | "LR" | "RL";

export interface FlowNode {
  id: string;
  text: string;
  /** Mermaid's name for the shape: "square", "diamond", "stadium", "doc"... */
  shape: string;
  classes: string[];
  styles: Record<string, string>;
  /** Id of the subgraph this node sits in. */
  parent: string | null;
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string;
  stroke: "normal" | "thick" | "dotted";
  startArrow: boolean;
  endArrow: boolean;
  styles: Record<string, string>;
}

export interface FlowSubgraph {
  id: string;
  title: string;
  parent: string | null;
  styles: Record<string, string>;
}

export interface Flowchart {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
}

export class MermaidParseError extends Error {
  /** 1-based line in the text that was parsed, when known. */
  line?: number;
  constructor(message: string, line?: number) {
    super(message);
    this.name = "MermaidParseError";
    this.line = line;
  }
}

const ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u;

/** Opening bracket, the closing brackets it can end with, and the shape each gives. Longest first. */
const BRACKETS: Array<[string, Array<[string, string]>]> = [
  ["(((", [[")))", "doublecircle"]]],
  ["((", [["))", "circle"]]],
  ["([", [["])", "stadium"]]],
  ["[(", [[")]", "cylinder"]]],
  ["[[", [["]]", "subroutine"]]],
  ["[/", [["/]", "lean_right"], ["\\]", "trapezoid"]]],
  ["[\\", [["\\]", "lean_left"], ["/]", "inv_trapezoid"]]],
  ["{{", [["}}", "hexagon"]]],
  ["{", [["}", "diamond"]]],
  ["(", [[")", "round"]]],
  ["[", [["]", "square"]]],
  [">", [["]", "odd"]]],
];

const ENTITIES: Record<string, string> = {
  quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " ", apos: "'",
};

/** Label text as plain text: line breaks, quotes and Mermaid's #entities; decoded. */
export function cleanText(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  // Markdown strings are written "`like this`".
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/[#&](\w+);/g, (all, name: string) => {
      if (/^\d+$/.test(name)) return String.fromCodePoint(Number(name));
      return ENTITIES[name.toLowerCase()] ?? all;
    })
    .split("\n").map(line => line.trim()).join("\n")
    .trim();
}

function parseStyles(text: string): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const part of text.split(",")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().replace(/;$/, "");
    if (key && value) styles[key] = value;
  }
  return styles;
}

/** Take the header, comments and fences off, and split into statements that remember their line. */
function statements(source: string): { header: string; items: Array<{ text: string; line: number }> } {
  let lines = source.replace(/\r\n?/g, "\n").split("\n");

  // A pasted code block: keep what's inside the fence.
  const open = lines.findIndex(l => /^\s*(```|~~~)\s*mermaid\b/i.test(l));
  if (open >= 0) {
    const close = lines.findIndex((l, i) => i > open && /^\s*(```|~~~)\s*$/.test(l));
    lines = lines.map((l, i) => (i > open && (close < 0 || i < close) ? l : ""));
  }

  // Front matter (--- ... ---) holds a title or config, not chart content.
  const first = lines.findIndex(l => l.trim().length > 0);
  if (first >= 0 && lines[first].trim() === "---") {
    const end = lines.findIndex((l, i) => i > first && l.trim() === "---");
    if (end > 0) for (let i = first; i <= end; i++) lines[i] = "";
  }

  let header = "";
  const items: Array<{ text: string; line: number }> = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/%%\{.*?\}%%/g, "").trim();
    if (!line || line.startsWith("%%")) return;
    if (!header) { header = line; return; }
    // Semicolons separate statements, except inside quotes and #entities; like #quot;
    let current = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      if (ch === ";" && !quoted && !/[#&]\w+$/.test(current)) {
        if (current.trim()) items.push({ text: current.trim(), line: index + 1 });
        current = "";
      } else current += ch;
    }
    if (current.trim()) items.push({ text: current.trim(), line: index + 1 });
  });
  return { header, items };
}

interface Link {
  stroke: FlowEdge["stroke"];
  startArrow: boolean;
  endArrow: boolean;
  label: string;
  invisible: boolean;
}

class StatementParser {
  pos = 0;
  constructor(private text: string, private line: number) {}

  get rest(): string { return this.text.slice(this.pos); }
  get done(): boolean { return this.pos >= this.text.length; }

  skipSpace() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  fail(message: string): never {
    throw new MermaidParseError(message, this.line);
  }

  /** Text up to one of the closers; quoted text can hold anything. Returns the text and which closer ended it. */
  private bracketText(closers: string[]): { text: string; closer: string } {
    this.skipSpace();
    if (this.text[this.pos] === '"') {
      const end = this.text.indexOf('"', this.pos + 1);
      if (end < 0) this.fail("A quoted label is missing its closing quote");
      const text = this.text.slice(this.pos, end + 1);
      this.pos = end + 1;
      this.skipSpace();
      const closer = closers.find(c => this.text.startsWith(c, this.pos));
      if (!closer) this.fail(`Expected ${closers.join(" or ")} after ${text}`);
      this.pos += closer.length;
      return { text, closer };
    }
    let best = -1, bestCloser = "";
    for (const closer of closers) {
      const at = this.text.indexOf(closer, this.pos);
      if (at >= 0 && (best < 0 || at < best)) { best = at; bestCloser = closer; }
    }
    if (best < 0) this.fail(`A shape is missing its closing ${closers.join(" or ")}`);
    const text = this.text.slice(this.pos, best);
    this.pos = best + bestCloser.length;
    return { text, closer: bestCloser };
  }

  /** `@{ shape: doc, label: "Text" }` */
  private attributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    let depth = 0, quoted = false, end = -1;
    for (let i = this.pos; i < this.text.length; i++) {
      const ch = this.text[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "{") depth++;
      else if (!quoted && ch === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) this.fail("A shape written with @{ is missing its closing }");
    const body = this.text.slice(this.pos + 2, end);
    this.pos = end + 1;

    let part = "";
    quoted = false;
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === '"') quoted = !quoted;
      if (ch === "," && !quoted) { parts.push(part); part = ""; } else part += ch;
    }
    parts.push(part);
    for (const p of parts) {
      const colon = p.indexOf(":");
      if (colon < 0) continue;
      attrs[p.slice(0, colon).trim().toLowerCase()] = p.slice(colon + 1).trim();
    }
    return attrs;
  }

  node(): { id: string; text?: string; shape?: string; classes: string[] } {
    this.skipSpace();
    const match = ID.exec(this.rest);
    if (!match) this.fail(`Expected a node name at "${this.rest.slice(0, 20)}"`);
    const id = match[0];
    this.pos += id.length;

    let text: string | undefined, shape: string | undefined;
    if (this.text.startsWith("@{", this.pos)) {
      const attrs = this.attributes();
      if (attrs.shape) shape = cleanText(attrs.shape).toLowerCase();
      if (attrs.label !== undefined) text = cleanText(attrs.label);
    } else {
      for (const [open, closers] of BRACKETS) {
        if (!this.text.startsWith(open, this.pos)) continue;
        this.pos += open.length;
        const found = this.bracketText(closers.map(c => c[0]));
        text = cleanText(found.text);
        shape = closers.find(c => c[0] === found.closer)![1];
        break;
      }
    }

    const classes: string[] = [];
    while (this.text.startsWith(":::", this.pos)) {
      const cls = /^[\w-]+/.exec(this.text.slice(this.pos + 3));
      if (!cls) this.fail("Expected a class name after :::");
      classes.push(cls[0]);
      this.pos += 3 + cls[0].length;
    }
    return { id, text, shape, classes };
  }

  /** The line between two nodes, or null at the end of the statement. */
  link(): Link | null {
    this.skipSpace();
    if (this.done) return null;
    const rest = this.rest;
    let m: RegExpExecArray | null;
    let link: Link | null = null;
    const heads = (start: string | undefined, end: string | undefined) => ({
      startArrow: !!start,
      endArrow: !!end,
    });

    // Plain lines first, so that "--o B" is a circle end and not the start of a label.
    if ((m = /^([<ox](?=-))?-\.+-(>|[ox](?=\s|$))?/.exec(rest))) {
      link = { stroke: "dotted", ...heads(m[1], m[2]), label: "", invisible: false };
    } else if ((m = /^([<ox](?==))?(={2,})(>|[ox](?=\s|$))?/.exec(rest)) && (m[3] || m[2].length >= 3)) {
      link = { stroke: "thick", ...heads(m[1], m[3]), label: "", invisible: false };
    } else if ((m = /^([<ox](?=-))?(-{2,})(>|[ox](?=\s|$))?/.exec(rest)) && (m[3] || m[2].length >= 3)) {
      link = { stroke: "normal", ...heads(m[1], m[3]), label: "", invisible: false };
    } else if ((m = /^~{3,}/.exec(rest))) {
      link = { stroke: "normal", startArrow: false, endArrow: false, label: "", invisible: true };
    // With the label inside the line: -- text -->, == text ==>, -. text .->
    } else if ((m = /^([<ox](?=-))?--(?![->])\s*(\S.*?)\s*-{2,}(>|[ox](?=\s|$))?/.exec(rest))) {
      link = { stroke: "normal", ...heads(m[1], m[3]), label: cleanText(m[2]), invisible: false };
    } else if ((m = /^([<ox](?==))?==(?![=>])\s*(\S.*?)\s*={2,}(>|[ox](?=\s|$))?/.exec(rest))) {
      link = { stroke: "thick", ...heads(m[1], m[3]), label: cleanText(m[2]), invisible: false };
    } else if ((m = /^([<ox](?=-))?-\.(?![-.])\s*(\S.*?)\s*\.+-(>|[ox](?=\s|$))?/.exec(rest))) {
      link = { stroke: "dotted", ...heads(m[1], m[3]), label: cleanText(m[2]), invisible: false };
    }
    if (!link || !m) this.fail(`Expected a line such as --> at "${rest.slice(0, 20)}"`);
    this.pos += m[0].length;

    // Label after the line: -->|text|
    this.skipSpace();
    if (this.text[this.pos] === "|") {
      const start = this.pos + 1;
      let end: number;
      if (this.text[start] === '"') {
        const quote = this.text.indexOf('"', start + 1);
        end = quote < 0 ? -1 : this.text.indexOf("|", quote + 1);
      } else end = this.text.indexOf("|", start);
      if (end < 0) this.fail("A line label is missing its closing |");
      link.label = cleanText(this.text.slice(start, end));
      this.pos = end + 1;
    }
    return link;
  }
}

export function parseFlowchart(source: string): Flowchart {
  const { header, items } = statements(source);
  if (!header) throw new MermaidParseError("There's no Mermaid code to read");

  const head = /^(flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?\s*;?\s*(.*)$/i.exec(header);
  if (!head) {
    const kind = /^[A-Za-z-]+/.exec(header)?.[0] ?? header.slice(0, 20);
    throw new MermaidParseError(`Only flowcharts can be added to a canvas (this starts with "${kind}")`, 1);
  }
  const dir = (head[2] ?? "TD").toUpperCase();
  const direction: FlowDirection = dir === "TB" ? "TD" : (dir as FlowDirection);
  if (head[3]) items.unshift({ text: head[3], line: 1 });

  const nodes = new Map<string, FlowNode>();
  const subgraphs = new Map<string, FlowSubgraph>();
  const edges: FlowEdge[] = [];
  const classDefs = new Map<string, Record<string, string>>();
  const pendingStyles: Array<[string, Record<string, string>]> = [];
  const pendingLinkStyles: Array<[string, Record<string, string>]> = [];
  const pendingClasses: Array<[string, string]> = [];
  const stack: string[] = [];
  let unnamed = 0;

  const touch = (found: { id: string; text?: string; shape?: string; classes: string[] }): string => {
    let node = nodes.get(found.id);
    if (!node) {
      node = { id: found.id, text: found.id, shape: "square", classes: [], styles: {}, parent: null };
      nodes.set(found.id, node);
    }
    if (found.text !== undefined) node.text = found.text;
    if (found.shape) node.shape = found.shape;
    for (const cls of found.classes) if (!node.classes.includes(cls)) node.classes.push(cls);
    if (node.parent === null && stack.length) node.parent = stack[stack.length - 1];
    return found.id;
  };

  for (const { text, line } of items) {
    let m: RegExpExecArray | null;

    if ((m = /^subgraph\b\s*(.*)$/.exec(text))) {
      const spec = m[1].trim();
      let id = "", title = "";
      const bracket = /^([^\s\[]+)\s*\[(.*)\]$/.exec(spec);
      if (bracket) { id = bracket[1]; title = cleanText(bracket[2]); }
      else if (/^[^\s"]+$/.test(spec)) { id = spec; title = spec; }
      else { id = `subGraph${unnamed++}`; title = cleanText(spec); }
      if (!id) id = `subGraph${unnamed++}`;
      if (!subgraphs.has(id)) {
        subgraphs.set(id, { id, title, parent: stack.length ? stack[stack.length - 1] : null, styles: {} });
      }
      stack.push(id);
      continue;
    }
    if (/^end$/.test(text)) {
      if (!stack.length) throw new MermaidParseError('"end" without a subgraph to close', line);
      stack.pop();
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(text))) {
      for (const id of m[1].split(",")) pendingStyles.push([id.trim(), parseStyles(m[2])]);
      continue;
    }
    if ((m = /^classDef\s+(\S+)\s+(.+)$/.exec(text))) {
      for (const name of m[1].split(",")) classDefs.set(name.trim(), parseStyles(m[2]));
      continue;
    }
    if ((m = /^class\s+(\S+)\s+([\w-]+)$/.exec(text))) {
      for (const id of m[1].split(",")) pendingClasses.push([id.trim(), m[2]]);
      continue;
    }
    if ((m = /^linkStyle\s+(\S+)\s+(.+)$/.exec(text))) {
      for (const index of m[1].split(",")) pendingLinkStyles.push([index.trim(), parseStyles(m[2])]);
      continue;
    }
    if (/^(direction|click|accTitle|accDescr|title|interpolate)\b/.test(text)) continue;

    // A chain: A & B --> C -->|label| D
    const parser = new StatementParser(text, line);
    const group = (): string[] => {
      const found = [touch(parser.node())];
      for (;;) {
        parser.skipSpace();
        if (parser.rest[0] !== "&") return found;
        parser.pos++;
        found.push(touch(parser.node()));
      }
    };
    let left = group();
    for (;;) {
      const link = parser.link();
      if (!link) break;
      const right = group();
      if (!link.invisible) {
        for (const from of left) {
          for (const to of right) {
            edges.push({
              from, to, label: link.label, stroke: link.stroke,
              startArrow: link.startArrow, endArrow: link.endArrow, styles: {},
            });
          }
        }
      }
      left = right;
    }
  }

  if (stack.length) throw new MermaidParseError(`The subgraph "${stack[stack.length - 1]}" is missing its "end"`);

  // A subgraph's name used in a line (A --> SubgraphName) is the subgraph, not a new node.
  for (const id of Array.from(nodes.keys())) {
    if (subgraphs.has(id)) nodes.delete(id);
  }

  for (const [id, cls] of pendingClasses) {
    const node = nodes.get(id);
    if (node && !node.classes.includes(cls)) node.classes.push(cls);
  }
  const defaults = classDefs.get("default") ?? {};
  for (const node of nodes.values()) {
    Object.assign(node.styles, defaults);
    for (const cls of node.classes) Object.assign(node.styles, classDefs.get(cls) ?? {});
  }
  for (const [id, styles] of pendingStyles) {
    const target = nodes.get(id) ?? subgraphs.get(id);
    if (target) Object.assign(target.styles, styles);
  }
  for (const [index, styles] of pendingLinkStyles) {
    if (index === "default") for (const edge of edges) edge.styles = { ...styles, ...edge.styles };
  }
  for (const [index, styles] of pendingLinkStyles) {
    const edge = /^\d+$/.test(index) ? edges[Number(index)] : undefined;
    if (edge) Object.assign(edge.styles, styles);
  }

  return {
    direction,
    nodes: Array.from(nodes.values()),
    edges,
    subgraphs: Array.from(subgraphs.values()),
  };
}
