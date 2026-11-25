/**
 * Turns a canvas into a Mermaid flowchart.
 *
 * Works on the saved canvas data (the JSON Canvas format plus CanvasFlow's own
 * fields), not on Obsidian's live objects, so it has no Obsidian dependency.
 *
 * Mermaid lays charts out itself, so positions, sizes, line bends and label
 * positions are left out. What carries over: card text, shapes, groups (as
 * subgraphs), lines with their arrowheads, style and labels, and colours.
 */

import { cleanText } from "./mermaidParse";

type AnyObj = any;

/** The name a card or group goes by in Mermaid code (the `A` in `A[Text]`), saved on it in the .canvas file. */
export const MERMAID_ID_KEY = "canvasflowMermaidId";

export interface MermaidExportOptions {
  /** Only export these cards and groups (and the lines between them). Empty or missing: export everything. */
  onlyIds?: Set<string>;
  /**
   * Names handed out earlier to cards that have none saved, by canvas id. New
   * names are added to it, so a card keeps its name from one export to the next.
   */
  names?: Map<string, string>;
}

export interface MermaidExportResult {
  code: string;
  nodeCount: number;
  edgeCount: number;
}

type Direction = "TD" | "BT" | "LR" | "RL";

/**
 * How each CanvasFlow shape is written. Shapes with a classic bracket form use
 * it, since every Mermaid version reads those. The rest use the `@{ shape }`
 * form (Mermaid 11.3 and later). Shapes Mermaid has no match for are left out
 * of both maps and become rectangles.
 */
const BRACKETS: Record<string, [string, string]> = {
  rectangle: ["[", "]"],
  terminator: ["([", "])"],
  ellipse: ["((", "))"],
  diamond: ["{", "}"],
  parallelogram: ["[/", "/]"],
  trapezoid: ["[/", "\\]"],
  hexagon: ["{{", "}}"],
  process: ["[[", "]]"],
  cylinder: ["[(", ")]"],
};

const NAMED_SHAPES: Record<string, string> = {
  triangle: "tri",
  merge: "flip-tri",
  document: "doc",
  documents: "docs",
  "cylinder-side": "h-cyl",
  "stored-data": "bow-rect",
  display: "curv-trap",
  "paper-tape": "flag",
  brace: "brace-r",
  "brace-left": "brace",
};

/** Obsidian's six preset card colours (default theme). */
export const PRESET_COLORS: Record<string, string> = {
  "1": "#fb464c",
  "2": "#e9973f",
  "3": "#e0de71",
  "4": "#44cf6e",
  "5": "#53dfdd",
  "6": "#a882ff",
};

function colorOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (PRESET_COLORS[value]) return PRESET_COLORS[value];
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/** Card text as a quoted Mermaid label: one line per line of text, with heading and list marks removed. */
function quote(text: string): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    // Mermaid shows "Unsupported markdown: list" for a label that starts like a list item.
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\s*(\d+)\.\s+/, "$1) ")
      .trim())
    .filter(line => line.length > 0);
  const safe = lines
    .join("<br/>")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;");
  // Mermaid rejects an empty label, so an empty card gets a space.
  return `"${safe || " "}"`;
}

function nodeText(node: AnyObj): string {
  switch (node.type) {
    case "text": return node.text ?? "";
    case "file": {
      const name = String(node.file ?? "").split("/").pop() ?? "";
      return name.replace(/\.md$/i, "") + (node.subpath ?? "");
    }
    case "link": return node.url ?? "";
    case "group": return node.label ?? "";
    default: return "";
  }
}

/** A card's label as Mermaid code reads it back: plain lines, without heading or list marks. */
export function exportedText(node: AnyObj): string {
  return cleanText(quote(nodeText(node)));
}

/** The CanvasFlow shape a card comes back as after a trip through Mermaid: its own, or a rectangle when Mermaid has no match. */
export function exportedShape(node: AnyObj): string {
  const shape = node.type === "text" ? node.canvasflowShape : undefined;
  return shape && (BRACKETS[shape] || NAMED_SHAPES[shape]) ? shape : "rectangle";
}

const ID_PATTERN = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*$/u;
const RESERVED = /^(end|subgraph|graph|flowchart|style|class|classDef|linkStyle|click|direction|default|call|href)$/i;

export function isValidMermaidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && !RESERVED.test(id);
}

/**
 * The Mermaid name of every card and group, by canvas id. A saved name wins,
 * then one handed out earlier (`names`), then a new one: N1, N2... for cards
 * and G1, G2... for groups, in reading order. Two cards never share a name
 * (a copied card keeps its saved name only if the original isn't there).
 */
export function resolveMermaidIds(nodes: AnyObj[], names?: Map<string, string>): Map<string, string> {
  const sorted = nodes.filter(n => n?.id).slice().sort(byPosition);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const take = (node: AnyObj, name: unknown) => {
    if (ids.has(node.id) || !isValidMermaidId(name) || used.has(name)) return;
    ids.set(node.id, name);
    used.add(name);
  };
  for (const node of sorted) take(node, node[MERMAID_ID_KEY]);
  for (const node of sorted) take(node, names?.get(node.id));
  let cards = 0, groups = 0;
  for (const node of sorted) {
    while (!ids.has(node.id)) take(node, node.type === "group" ? `G${++groups}` : `N${++cards}`);
    names?.set(node.id, ids.get(node.id)!);
  }
  return ids;
}

function nodeDeclaration(id: string, node: AnyObj): string {
  const label = quote(nodeText(node));
  const shape = node.type === "text" ? node.canvasflowShape : undefined;
  const named = shape ? NAMED_SHAPES[shape] : undefined;
  if (named) return `${id}@{ shape: ${named}, label: ${label} }`;
  const [open, close] = (shape && BRACKETS[shape]) || BRACKETS.rectangle;
  return `${id}${open}${label}${close}`;
}

function area(node: AnyObj): number {
  return (node.width ?? 0) * (node.height ?? 0);
}

function contains(group: AnyObj, node: AnyObj): boolean {
  return node.x >= group.x && node.y >= group.y
    && node.x + node.width <= group.x + group.width
    && node.y + node.height <= group.y + group.height;
}

/** Reading order: top to bottom, then left to right. */
function byPosition(a: AnyObj, b: AnyObj): number {
  return (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);
}

/** The way most lines run, from the sides they leave by (or the cards' positions when a side is missing). */
function pickDirection(edges: AnyObj[], nodesById: Map<string, AnyObj>): Direction {
  const votes: Record<Direction, number> = { TD: 0, BT: 0, LR: 0, RL: 0 };
  const bySide: Record<string, Direction> = { bottom: "TD", top: "BT", right: "LR", left: "RL" };
  for (const edge of edges) {
    // A line with its only arrowhead at the start is written the other way round.
    const flipped = isFlipped(edge);
    const side = flipped ? edge.toSide : edge.fromSide;
    if (bySide[side]) { votes[bySide[side]]++; continue; }
    const from = nodesById.get(flipped ? edge.toNode : edge.fromNode);
    const to = nodesById.get(flipped ? edge.fromNode : edge.toNode);
    if (!from || !to) continue;
    const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
    const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
    if (Math.abs(dy) >= Math.abs(dx)) votes[dy >= 0 ? "TD" : "BT"]++;
    else votes[dx >= 0 ? "LR" : "RL"]++;
  }
  let best: Direction = "TD";
  for (const dir of ["TD", "LR", "BT", "RL"] as Direction[]) {
    if (votes[dir] > votes[best]) best = dir;
  }
  return best;
}

function hasArrow(end: unknown, fallback: boolean): boolean {
  return end === undefined || end === null ? fallback : end === "arrow";
}

/** In a canvas, lines have no arrow at the start and one at the end unless set otherwise. */
function isFlipped(edge: AnyObj): boolean {
  return hasArrow(edge.fromEnd, false) && !hasArrow(edge.toEnd, true);
}

export interface ExportedEdge {
  /** Canvas ids, the way round the line is written in Mermaid. */
  from: string;
  to: string;
  /** True when Mermaid's "from" is the canvas line's "to" end. */
  flipped: boolean;
  startArrow: boolean;
  endArrow: boolean;
  stroke: "normal" | "thick" | "dotted";
  label: string;
}

/** A canvas line as Mermaid sees it. */
export function exportedEdge(edge: AnyObj): ExportedEdge {
  const flipped = isFlipped(edge);
  const start = hasArrow(edge.fromEnd, false);
  const end = hasArrow(edge.toEnd, true);
  const line = edge.canvasflowLine ?? {};
  const label = edgeLabel(edge);
  return {
    from: flipped ? edge.toNode : edge.fromNode,
    to: flipped ? edge.fromNode : edge.toNode,
    flipped,
    startArrow: start && end,
    endArrow: start || end,
    stroke: line.style === "dashed" || line.style === "dotted" ? "dotted"
      : (line.width ?? 2) >= 4 ? "thick" : "normal",
    label: label ? cleanText(label) : "",
  };
}

function arrowFor(edge: AnyObj): string {
  const view = exportedEdge(edge);
  const kind = view.stroke;
  const both = view.startArrow && view.endArrow;
  const none = !view.startArrow && !view.endArrow;
  if (kind === "dotted") return both ? "<-.->" : none ? "-.-" : "-.->";
  if (kind === "thick") return both ? "<==>" : none ? "===" : "==>";
  return both ? "<-->" : none ? "---" : "-->";
}

function edgeLabel(edge: AnyObj): string {
  const extras: AnyObj[] = Array.isArray(edge.canvasflowLabels) ? edge.canvasflowLabels : [];
  const texts = [edge.label, ...extras.map(l => l?.text)]
    .filter(t => typeof t === "string" && t.trim().length > 0);
  // Mermaid lines take one label, so several are stacked in it.
  return texts.length ? quote(texts.join("\n")) : "";
}

export function canvasToMermaid(data: AnyObj, options: MermaidExportOptions = {}): MermaidExportResult {
  const only = options.onlyIds && options.onlyIds.size > 0 ? options.onlyIds : null;
  const allNodes: AnyObj[] = Array.isArray(data?.nodes) ? data.nodes : [];
  const allEdges: AnyObj[] = Array.isArray(data?.edges) ? data.edges : [];

  const nodes = allNodes.filter(n => n?.id && (!only || only.has(n.id))).sort(byPosition);
  const nodesById = new Map<string, AnyObj>(nodes.map(n => [n.id, n]));
  const edges = allEdges.filter(e => nodesById.has(e?.fromNode) && nodesById.has(e?.toNode));

  // Names are worked out over the whole canvas, so a card has the same one whether or not it's selected.
  const ids = resolveMermaidIds(allNodes, options.names);
  const groupCount = nodes.filter(n => n.type === "group").length;
  const cardCount = nodes.length - groupCount;

  // Each card or group belongs to the smallest group that fully holds it.
  const groups = nodes.filter(n => n.type === "group");
  const children = new Map<string | null, AnyObj[]>();
  for (const node of nodes) {
    let parent: AnyObj | null = null;
    for (const group of groups) {
      if (group === node || !contains(group, node)) continue;
      // Two groups of the same size would otherwise hold each other.
      if (node.type === "group" && area(group) <= area(node)) continue;
      if (!parent || area(group) < area(parent)) parent = group;
    }
    const key = parent ? parent.id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(node);
  }

  const lines: string[] = [`flowchart ${pickDirection(edges, nodesById)}`];
  const styles: string[] = [];

  const emit = (parentId: string | null, depth: number) => {
    const pad = "    ".repeat(depth);
    for (const node of children.get(parentId) ?? []) {
      const id = ids.get(node.id)!;
      const color = colorOf(node.color);
      if (node.type === "group") {
        lines.push(`${pad}subgraph ${id}[${quote(nodeText(node))}]`);
        emit(node.id, depth + 1);
        lines.push(`${pad}end`);
        if (color) styles.push(`style ${id} stroke:${color},fill:${color}22`);
        continue;
      }
      lines.push(pad + nodeDeclaration(id, node));
      const parts: string[] = [];
      if (color) parts.push(`stroke:${color}`, `fill:${color}22`);
      const outline = node.type === "text" && node.canvasflowShape ? node.canvasflowShapeLine : null;
      if (outline?.width) parts.push(`stroke-width:${outline.width}px`);
      if (outline?.style === "dashed") parts.push("stroke-dasharray:6 4");
      if (outline?.style === "dotted") parts.push("stroke-dasharray:2 3");
      if (parts.length) styles.push(`style ${id} ${parts.join(",")}`);
    }
  };
  emit(null, 1);

  edges.forEach((edge, index) => {
    const flipped = isFlipped(edge);
    const from = ids.get(flipped ? edge.toNode : edge.fromNode)!;
    const to = ids.get(flipped ? edge.fromNode : edge.toNode)!;
    const label = edgeLabel(edge);
    lines.push(`    ${from} ${arrowFor(edge)}${label ? `|${label}|` : ""} ${to}`);
    const color = colorOf(edge.color);
    if (color) styles.push(`linkStyle ${index} stroke:${color}`);
  });

  for (const style of styles) lines.push(`    ${style}`);

  return { code: lines.join("\n"), nodeCount: cardCount + groupCount, edgeCount: edges.length };
}
