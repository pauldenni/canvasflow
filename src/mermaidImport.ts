/**
 * Turns a Mermaid flowchart into canvas cards, groups and lines.
 *
 * Mermaid has no positions, so the chart is laid out here (with dagre, the
 * layered layout Mermaid itself uses by default). The result is plain canvas
 * data, ready to hand to the canvas; nothing here touches Obsidian.
 */

import * as dagre from "@dagrejs/dagre";
import { MERMAID_ID_KEY, PRESET_COLORS, isValidMermaidId } from "./mermaidExport";
import { FlowDirection, FlowEdge, FlowNode, Flowchart, parseFlowchart } from "./mermaidParse";

type AnyObj = any;

export interface MermaidImportResult {
  /** Canvas data: groups first, then cards, and the lines between them. */
  nodes: AnyObj[];
  edges: AnyObj[];
  cardCount: number;
  groupCount: number;
}

/**
 * Mermaid's shape names (and the aliases of its `@{ shape }` form) to
 * CanvasFlow shapes. Anything not listed becomes a rectangle.
 */
export const MERMAID_SHAPES: Record<string, string> = {
  square: "rectangle", rect: "rectangle", rectangle: "rectangle", process: "rectangle", proc: "rectangle",
  round: "rectangle", rounded: "rectangle", event: "rectangle",
  stadium: "terminator", terminal: "terminator", pill: "terminator",
  circle: "ellipse", circ: "ellipse", doublecircle: "ellipse", "dbl-circ": "ellipse", "double-circle": "ellipse",
  diamond: "diamond", diam: "diamond", decision: "diamond", question: "diamond",
  hexagon: "hexagon", hex: "hexagon", prepare: "hexagon",
  lean_right: "parallelogram", lean_left: "parallelogram", "lean-r": "parallelogram", "lean-l": "parallelogram",
  "lean-right": "parallelogram", "lean-left": "parallelogram", "in-out": "parallelogram", "out-in": "parallelogram",
  trapezoid: "trapezoid", inv_trapezoid: "trapezoid", "trap-b": "trapezoid", "trap-t": "trapezoid",
  priority: "trapezoid", manual: "trapezoid",
  subroutine: "process", subproc: "process", subprocess: "process", "fr-rect": "process", "framed-rectangle": "process",
  cylinder: "cylinder", cyl: "cylinder", database: "cylinder", db: "cylinder",
  "h-cyl": "cylinder-side", das: "cylinder-side", "horizontal-cylinder": "cylinder-side",
  tri: "triangle", triangle: "triangle", extract: "triangle",
  "flip-tri": "merge", "flipped-triangle": "merge", "manual-file": "merge",
  doc: "document", document: "document",
  docs: "documents", documents: "documents", "st-doc": "documents", "stacked-document": "documents",
  "bow-rect": "stored-data", "bow-tie-rectangle": "stored-data", "stored-data": "stored-data",
  "curv-trap": "display", "curved-trapezoid": "display", display: "display",
  flag: "paper-tape", "paper-tape": "paper-tape",
  "brace-r": "brace", "comment-right": "brace",
  brace: "brace-left", "brace-l": "brace-left", comment: "brace-left",
  odd: "pentagon-arrow",
};

export const GROUP_PAD = 30;
/** Space between one row (or column) of cards and the next. */
export const ROW_GAP = 90;
export const EMPTY_GROUP = { width: 240, height: 120 };

function round10(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * A card size that fits the label. Cards can't be measured before they exist,
 * so this estimates from the text, then leaves room for the shape's corners.
 */
export function sizeFor(text: string, shape: string): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map(l => l.length));
  let width = Math.min(320, Math.max(140, longest * 9 + 50));
  const perLine = Math.max(1, Math.floor((width - 50) / 9));
  const rows = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / perLine)), 0);
  let height = Math.max(60, rows * 26 + 34);

  switch (shape) {
    case "diamond":
      width = Math.max(160, width * 1.4);
      height = Math.max(120, height * 1.8);
      break;
    case "ellipse": {
      const size = Math.max(100, Math.min(width, longest * 9 + 60), height * 1.5);
      width = size;
      height = size;
      break;
    }
    case "triangle":
    case "merge":
      width = Math.max(180, width * 1.5);
      height = Math.max(150, height * 1.9);
      break;
    case "hexagon": case "parallelogram": case "trapezoid": case "stored-data":
    case "display": case "cylinder-side": case "pentagon-arrow": case "brace": case "brace-left":
      width += 50;
      height = Math.max(70, height);
      break;
    case "terminator": case "process":
      width += 30;
      break;
    case "cylinder":
      height += 50;
      break;
    case "document": case "documents": case "paper-tape":
      height += 30;
      break;
  }
  return { width: round10(width), height: round10(height) };
}

/** A colour from Mermaid styles as a canvas colour: a preset number when it matches one, else #rrggbb. */
export function canvasColor(styles: Record<string, string>): string | undefined {
  for (const key of ["stroke", "fill"]) {
    let value = (styles[key] ?? "").trim().toLowerCase();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
    if (short) value = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    const long = /^(#[0-9a-f]{6})([0-9a-f]{2})?$/.exec(value);
    if (!long) continue;
    const preset = Object.keys(PRESET_COLORS).find(k => PRESET_COLORS[k] === long[1]);
    return preset ?? long[1];
  }
  return undefined;
}

/** `stroke-width` and `stroke-dasharray` as a CanvasFlow outline or line style. */
export function strokeOptions(styles: Record<string, string>, defaultWidth: number): AnyObj | undefined {
  const out: AnyObj = {};
  const width = parseFloat(styles["stroke-width"] ?? "");
  if (Number.isFinite(width) && width > 0) {
    // CanvasFlow's four thicknesses.
    const snapped = [1, 2, 4, 6].reduce((best, w) => (Math.abs(w - width) < Math.abs(best - width) ? w : best));
    if (snapped !== defaultWidth) out.width = snapped;
  }
  const dash = parseFloat(styles["stroke-dasharray"] ?? "");
  if (Number.isFinite(dash) && dash > 0) out.style = dash <= 2 ? "dotted" : "dashed";
  return Object.keys(out).length ? out : undefined;
}

export function newId(): string {
  let id = "";
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

export type Side = "top" | "bottom" | "left" | "right";
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Which sides a line leaves and arrives by. Lines follow the chart's
 * direction (bottom side to top side in a top-down chart, and so on). Two
 * cards level with each other are joined across. A line that runs back
 * against the chart's direction leaves and arrives by the same side, so it
 * loops around the cards in between and not through them.
 */
export function sidesFor(from: Rect, to: Rect, direction: FlowDirection): [Side, Side] {
  const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
  const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
  const vertical = direction === "TD" || direction === "BT";
  const forward = direction === "TD" || direction === "LR" ? 1 : -1;
  const along = (vertical ? dy : dx) * forward;
  const across = vertical ? dx : dy;
  const reach = vertical ? (from.height + to.height) / 4 : (from.width + to.width) / 4;

  const acrossSides: [Side, Side] = vertical ? ["right", "left"] : ["bottom", "top"];
  const alongSides: [Side, Side] = vertical ? ["bottom", "top"] : ["right", "left"];
  const flip = (sides: [Side, Side]): [Side, Side] => [sides[1], sides[0]];

  if (Math.abs(along) < reach && across !== 0) return across > 0 ? acrossSides : flip(acrossSides);
  if (along >= 0) return forward > 0 ? alongSides : flip(alongSides);
  // Loop round the outside: by the side the line starts furthest out on.
  const side = across > 0 ? acrossSides[1] : acrossSides[0];
  return [side, side];
}

/**
 * Lay the chart out and build canvas data, centred on `center`.
 * Throws MermaidParseError when the text can't be read.
 */
export function mermaidToCanvas(source: string, center = { x: 0, y: 0 }): MermaidImportResult {
  const chart: Flowchart = parseFlowchart(source);

  const shapeOf = (node: FlowNode) => MERMAID_SHAPES[node.shape] ?? "rectangle";
  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of chart.nodes) sizes.set(node.id, sizeFor(node.text || " ", shapeOf(node)));

  const subgraphIds = new Set(chart.subgraphs.map(s => s.id));
  const childrenOf = new Map<string, string[]>();
  const addChild = (parent: string | null, id: string) => {
    if (!parent || !subgraphIds.has(parent)) return;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(id);
  };
  for (const node of chart.nodes) addChild(node.parent, node.id);
  for (const sub of chart.subgraphs) addChild(sub.parent, sub.id);

  /** dagre can't attach a line to a group that has cards in it, so lines to a group are laid out to a card inside. */
  const anchorOf = (id: string, seen = new Set<string>()): string => {
    const kids = childrenOf.get(id);
    if (!subgraphIds.has(id) || !kids?.length || seen.has(id)) return id;
    seen.add(id);
    return anchorOf(kids[0], seen);
  };
  const isInside = (id: string, groupId: string): boolean => {
    for (const kid of childrenOf.get(groupId) ?? []) {
      if (kid === id || isInside(id, kid)) return true;
    }
    return false;
  };

  // With groups, dagre puts 2 x depth + 1 steps between one row of cards and the
  // next (room for the groups' edges), each `ranksep` apart. Divide it back out,
  // and leave a little more room per level for the groups' own padding.
  const levels = chart.subgraphs.reduce((max, sub) => {
    let depth = 1;
    for (let p = sub.parent; p && depth < 50; p = chart.subgraphs.find(s => s.id === p)?.parent ?? null) depth++;
    return Math.max(max, depth);
  }, 0);
  const rowGap = (ROW_GAP + GROUP_PAD * levels) / (2 * levels + 1);

  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({
    rankdir: chart.direction === "TD" ? "TB" : chart.direction,
    nodesep: 60,
    ranksep: rowGap,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of chart.nodes) graph.setNode(node.id, { ...sizes.get(node.id)! });
  for (const sub of chart.subgraphs) {
    graph.setNode(sub.id, childrenOf.get(sub.id)?.length ? {} : { ...EMPTY_GROUP });
  }
  for (const [parent, kids] of childrenOf) for (const kid of kids) graph.setParent(kid, parent);

  chart.edges.forEach((edge, index) => {
    if (isInside(edge.from, edge.to) || isInside(edge.to, edge.from)) return;
    const from = anchorOf(edge.from), to = anchorOf(edge.to);
    if (from === to || !graph.hasNode(from) || !graph.hasNode(to)) return;
    // Room for the label between the two cards.
    const label = edge.label
      ? { width: Math.min(260, edge.label.length * 8 + 16), height: 30, labelpos: "c" }
      : {};
    graph.setEdge(from, to, label, `e${index}`);
  });

  dagre.layout(graph);

  // Rectangles (top-left based) for every card and group.
  const rects = new Map<string, Rect>();
  for (const node of chart.nodes) {
    const at = graph.node(node.id);
    const size = sizes.get(node.id)!;
    rects.set(node.id, { x: at.x - size.width / 2, y: at.y - size.height / 2, ...size });
  }
  const groupRect = (id: string): Rect => {
    const known = rects.get(id);
    if (known) return known;
    const kids = childrenOf.get(id) ?? [];
    let rect: Rect;
    if (!kids.length) {
      const at = graph.node(id);
      rect = { x: at.x - EMPTY_GROUP.width / 2, y: at.y - EMPTY_GROUP.height / 2, ...EMPTY_GROUP };
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const kid of kids) {
        const r = subgraphIds.has(kid) ? groupRect(kid) : rects.get(kid)!;
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
      }
      rect = {
        x: minX - GROUP_PAD, y: minY - GROUP_PAD,
        width: maxX - minX + GROUP_PAD * 2, height: maxY - minY + GROUP_PAD * 2,
      };
    }
    rects.set(id, rect);
    return rect;
  };
  for (const sub of chart.subgraphs) groupRect(sub.id);

  // Move everything so the chart's middle sits on `center`, on whole pixels.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects.values()) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
  }
  const shiftX = Number.isFinite(minX) ? center.x - (minX + maxX) / 2 : 0;
  const shiftY = Number.isFinite(minY) ? center.y - (minY + maxY) / 2 : 0;
  for (const r of rects.values()) {
    r.x = Math.round(r.x + shiftX);
    r.y = Math.round(r.y + shiftY);
    r.width = Math.round(r.width);
    r.height = Math.round(r.height);
  }

  const canvasIds = new Map<string, string>();
  for (const id of rects.keys()) canvasIds.set(id, newId());

  // Outer groups first, so inner groups and cards sit on top of them.
  const depthOf = (sub: { parent: string | null }): number => {
    let depth = 0;
    for (let p = sub.parent; p && depth < 50; p = chart.subgraphs.find(s => s.id === p)?.parent ?? null) depth++;
    return depth;
  };
  const nodes: AnyObj[] = [];
  for (const sub of [...chart.subgraphs].sort((a, b) => depthOf(a) - depthOf(b))) {
    const group: AnyObj = { id: canvasIds.get(sub.id), type: "group", ...rects.get(sub.id)! };
    if (isValidMermaidId(sub.id)) group[MERMAID_ID_KEY] = sub.id;
    if (sub.title.trim()) group.label = sub.title;
    const color = canvasColor(sub.styles);
    if (color) group.color = color;
    nodes.push(group);
  }
  for (const node of chart.nodes) {
    const card: AnyObj = {
      id: canvasIds.get(node.id), type: "text", text: node.text, ...rects.get(node.id)!,
      canvasflowShape: shapeOf(node),
    };
    // Keep the name from the code (the A in A[Text]), so the card goes by it in the Mermaid panel.
    if (isValidMermaidId(node.id)) card[MERMAID_ID_KEY] = node.id;
    const color = canvasColor(node.styles);
    if (color) card.color = color;
    const outline = strokeOptions(node.styles, 1);
    if (outline) card.canvasflowShapeLine = outline;
    nodes.push(card);
  }

  const edges: AnyObj[] = [];
  for (const edge of chart.edges as FlowEdge[]) {
    const from = rects.get(edge.from), to = rects.get(edge.to);
    if (!from || !to) continue;
    const [fromSide, toSide] = sidesFor(from, to, chart.direction);
    const line: AnyObj = {
      id: newId(),
      fromNode: canvasIds.get(edge.from), fromSide,
      toNode: canvasIds.get(edge.to), toSide,
    };
    // A canvas line has an arrow at the end and none at the start unless told otherwise.
    if (edge.startArrow) line.fromEnd = "arrow";
    if (!edge.endArrow) line.toEnd = "none";
    if (edge.label) line.label = edge.label;
    const color = canvasColor(edge.styles);
    if (color) line.color = color;
    const style: AnyObj = strokeOptions(edge.styles, 2) ?? {};
    if (edge.stroke === "dotted" && !style.style) style.style = "dotted";
    if (edge.stroke === "thick" && !style.width) style.width = 4;
    if (Object.keys(style).length) line.canvasflowLine = style;
    edges.push(line);
  }

  return { nodes, edges, cardCount: chart.nodes.length, groupCount: chart.subgraphs.length };
}
