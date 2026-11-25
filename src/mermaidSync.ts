/**
 * Applies edited Mermaid code to a canvas that already has the chart on it.
 *
 * The canvas is the source of truth, so this changes as little as it can:
 * cards are matched to the code by their Mermaid name and keep their place and
 * size; only what the code says differently (text, shape, colour, a line's
 * arrowheads, style or label) is updated. Nodes that are new in the code are
 * placed next to the card they connect to, and cards and lines that are gone
 * from the code are removed. Locked cards are never removed.
 *
 * Like the export and import, this works on plain canvas data.
 */

import {
  MERMAID_ID_KEY, PRESET_COLORS, exportedEdge, exportedShape, exportedText, isValidMermaidId, resolveMermaidIds,
} from "./mermaidExport";
import {
  EMPTY_GROUP, GROUP_PAD, MERMAID_SHAPES, ROW_GAP, Rect, canvasColor, mermaidToCanvas, newId, sidesFor, sizeFor,
  strokeOptions,
} from "./mermaidImport";
import { FlowEdge, Flowchart, parseFlowchart } from "./mermaidParse";

type AnyObj = any;

export interface MermaidSyncOptions {
  /** Names handed out to cards that have none saved (see resolveMermaidIds). */
  names?: Map<string, string>;
  /** Where a chart goes when nothing on the canvas matches it. */
  center?: { x: number; y: number };
}

export interface MermaidSyncResult {
  /** The canvas data with the code applied. The data passed in is left alone. */
  data: AnyObj;
  changed: boolean;
  cardsAdded: number;
  cardsRemoved: number;
  linesAdded: number;
  linesRemoved: number;
  updated: number;
  /** True when every card on the canvas would go. Worth asking before applying. */
  removesEverything: boolean;
}

/** A card's colour as the export writes it (preset number or #rrggbb), or undefined when it isn't exported. */
function currentColor(item: AnyObj): string | undefined {
  const value = typeof item.color === "string" ? item.color.toLowerCase() : "";
  if (PRESET_COLORS[value]) return value;
  if (!/^#[0-9a-f]{6}$/.test(value)) return undefined;
  return Object.keys(PRESET_COLORS).find(k => PRESET_COLORS[k] === value) ?? value;
}

function setOrDelete(target: AnyObj, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") delete target[key];
  else target[key] = value;
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
    && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function boundsOf(rects: Rect[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
  }
  return { minX, minY, maxX, maxY };
}

export function syncCanvasFromMermaid(data: AnyObj, source: string, options: MermaidSyncOptions = {}): MermaidSyncResult {
  const chart: Flowchart = parseFlowchart(source);
  const oldNodes: AnyObj[] = Array.isArray(data?.nodes) ? data.nodes.filter((n: AnyObj) => n?.id) : [];
  const oldEdges: AnyObj[] = Array.isArray(data?.edges) ? data.edges : [];
  const center = options.center ?? { x: 0, y: 0 };

  const names = resolveMermaidIds(oldNodes, options.names);
  const chartNodes = new Map(chart.nodes.map(n => [n.id, n]));
  const chartSubs = new Map(chart.subgraphs.map(s => [s.id, s]));

  // A card matches a node of the same name; a group matches a subgraph.
  const matchOf = (node: AnyObj): string | null => {
    const name = names.get(node.id);
    if (!name) return null;
    return (node.type === "group" ? chartSubs.has(name) : chartNodes.has(name)) ? name : null;
  };
  const isKept = (node: AnyObj) => matchOf(node) !== null || node.canvasflowLocked === true;

  const result: MermaidSyncResult = {
    data, changed: false, cardsAdded: 0, cardsRemoved: 0, linesAdded: 0, linesRemoved: 0, updated: 0,
    removesEverything: false,
  };
  const removed = oldNodes.filter(n => !isKept(n));
  result.cardsRemoved = removed.length;
  result.removesEverything = oldNodes.length > 0 && removed.length === oldNodes.length;

  // Nothing on the canvas is in the code: lay the whole chart out afresh.
  if (!oldNodes.some(n => matchOf(n) !== null)) {
    const fresh = mermaidToCanvas(source, center);
    const kept = oldNodes.filter(isKept);
    const keptIds = new Set(kept.map(n => n.id));
    const keptEdges = oldEdges.filter(e => keptIds.has(e.fromNode) && keptIds.has(e.toNode));
    result.cardsAdded = fresh.nodes.length;
    result.linesAdded = fresh.edges.length;
    result.linesRemoved = oldEdges.length - keptEdges.length;
    result.changed = fresh.nodes.length > 0 || removed.length > 0 || result.linesRemoved > 0;
    result.data = { ...data, nodes: [...kept, ...fresh.nodes], edges: [...keptEdges, ...fresh.edges] };
    return result;
  }

  // --- Cards and groups already on the canvas ---
  const keptNodes: AnyObj[] = [];
  const canvasIdOf = new Map<string, string>();   // Mermaid name -> canvas id
  const rects = new Map<string, Rect>();           // Mermaid name -> place on the canvas
  const obstacles: Rect[] = [];

  for (const old of oldNodes) {
    if (!isKept(old)) continue;
    const node = { ...old };
    keptNodes.push(node);
    const rect: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
    if (node.type !== "group") obstacles.push(rect);
    const name = matchOf(old);
    if (!name) continue;   // locked, and not in the code: left as it is
    canvasIdOf.set(name, node.id);
    rects.set(name, rect);

    let touched = false;
    if (node.type === "group") {
      const sub = chartSubs.get(name)!;
      if (sub.title !== exportedText(node)) { setOrDelete(node, "label", sub.title); touched = true; }
      const color = canvasColor(sub.styles);
      if (color !== currentColor(node)) { setOrDelete(node, "color", color); touched = true; }
    } else {
      const found = chartNodes.get(name)!;
      if (node.type === "text") {
        if (found.text !== exportedText(node)) { node.text = found.text; touched = true; }
        const shape = MERMAID_SHAPES[found.shape] ?? "rectangle";
        // A shape Mermaid has no match for reads back as a rectangle; that isn't a change.
        if (shape !== node.canvasflowShape && shape !== exportedShape(node)) { node.canvasflowShape = shape; touched = true; }
        if (node.canvasflowShape) {
          const outline = strokeOptions(found.styles, 1) ?? {};
          const now = node.canvasflowShapeLine ?? {};
          const nowWidth = now.width && now.width !== 1 ? now.width : undefined;
          if (outline.width !== nowWidth || outline.style !== now.style) {
            setOrDelete(node, "canvasflowShapeLine", Object.keys(outline).length ? outline : undefined);
            touched = true;
          }
        }
      }
      const color = canvasColor(found.styles);
      if (color !== currentColor(node)) { setOrDelete(node, "color", color); touched = true; }
    }
    if (touched) result.updated++;
  }

  // --- Nodes that are new in the code ---
  const vertical = chart.direction === "TD" || chart.direction === "BT";
  const forward = chart.direction === "TD" || chart.direction === "LR" ? 1 : -1;

  const freeSpot = (size: { width: number; height: number }): Rect => {
    const box = boundsOf(obstacles);
    if (!box) return { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2), ...size };
    return vertical
      ? { x: box.maxX + 120, y: box.minY, ...size }
      : { x: box.minX, y: box.maxY + 120, ...size };
  };

  /** Next to `anchor`, one row on (or back) in the chart's direction, moved sideways to the nearest free place. */
  const placeBeside = (anchor: Rect, size: { width: number; height: number }, after: boolean): Rect => {
    const sign = (after ? 1 : -1) * forward;
    const base: Rect = vertical
      ? {
        x: anchor.x + anchor.width / 2 - size.width / 2,
        y: sign > 0 ? anchor.y + anchor.height + ROW_GAP : anchor.y - ROW_GAP - size.height,
        ...size,
      }
      : {
        x: sign > 0 ? anchor.x + anchor.width + ROW_GAP : anchor.x - ROW_GAP - size.width,
        y: anchor.y + anchor.height / 2 - size.height / 2,
        ...size,
      };
    const step = (vertical ? size.width : size.height) + 60;
    for (let i = 0; i < 41; i++) {
      // 0, +1, -1, +2, -2... so several new cards fan out around the one they hang off.
      const offset = (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * step;
      const rect = vertical ? { ...base, x: base.x + offset } : { ...base, y: base.y + offset };
      if (!obstacles.some(o => overlaps(rect, o, 30))) return rect;
    }
    return freeSpot(size);
  };

  const newCards: AnyObj[] = [];
  const pending = chart.nodes.filter(n => !canvasIdOf.has(n.id));
  while (pending.length) {
    let index = -1, anchor: Rect | undefined, after = true;
    // First choice: a new node that something already placed points to.
    for (const wantAfter of [true, false]) {
      for (let i = 0; i < pending.length && index < 0; i++) {
        const id = pending[i].id;
        const edge = chart.edges.find(e => (wantAfter ? e.to === id && rects.has(e.from) : e.from === id && rects.has(e.to)));
        if (edge) { index = i; anchor = rects.get(wantAfter ? edge.from : edge.to); after = wantAfter; }
      }
      if (index >= 0) break;
    }
    const found = pending.splice(index >= 0 ? index : 0, 1)[0];
    const shape = MERMAID_SHAPES[found.shape] ?? "rectangle";
    const size = sizeFor(found.text || " ", shape);
    const placed = anchor ? placeBeside(anchor, size, after) : freeSpot(size);
    const rect: Rect = { x: Math.round(placed.x), y: Math.round(placed.y), width: size.width, height: size.height };

    const card: AnyObj = { id: newId(), type: "text", text: found.text, ...rect, canvasflowShape: shape };
    if (isValidMermaidId(found.id)) card[MERMAID_ID_KEY] = found.id;
    const color = canvasColor(found.styles);
    if (color) card.color = color;
    const outline = strokeOptions(found.styles, 1);
    if (outline) card.canvasflowShapeLine = outline;

    newCards.push(card);
    canvasIdOf.set(found.id, card.id);
    rects.set(found.id, rect);
    obstacles.push(rect);
  }

  // --- Subgraphs that are new in the code: a group drawn round their cards ---
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let p = chartSubs.get(id)?.parent ?? null; p && depth < 50; p = chartSubs.get(p)?.parent ?? null) depth++;
    return depth;
  };
  const newGroups: AnyObj[] = [];
  const newSubs = chart.subgraphs.filter(s => !canvasIdOf.has(s.id)).sort((a, b) => depthOf(b.id) - depthOf(a.id));
  for (const sub of newSubs) {
    const members: Rect[] = [];
    for (const node of chart.nodes) if (node.parent === sub.id && rects.has(node.id)) members.push(rects.get(node.id)!);
    for (const child of chart.subgraphs) if (child.parent === sub.id && rects.has(child.id)) members.push(rects.get(child.id)!);
    const box = boundsOf(members);
    const rect: Rect = box
      ? {
        x: box.minX - GROUP_PAD, y: box.minY - GROUP_PAD,
        width: box.maxX - box.minX + GROUP_PAD * 2, height: box.maxY - box.minY + GROUP_PAD * 2,
      }
      : freeSpot(EMPTY_GROUP);
    const group: AnyObj = { id: newId(), type: "group", ...rect };
    if (sub.title.trim()) group.label = sub.title;
    if (isValidMermaidId(sub.id)) group[MERMAID_ID_KEY] = sub.id;
    const color = canvasColor(sub.styles);
    if (color) group.color = color;
    newGroups.unshift(group);   // outer groups first, so inner ones sit on top
    canvasIdOf.set(sub.id, group.id);
    rects.set(sub.id, rect);
    if (!box) obstacles.push(rect);
  }
  result.cardsAdded = newCards.length + newGroups.length;

  // --- Lines ---
  const nameOf = new Map<string, string>();   // canvas id -> Mermaid name, for what's still on the canvas
  for (const [name, id] of canvasIdOf) nameOf.set(id, name);
  const keptIds = new Set(keptNodes.map(n => n.id));

  const waiting = new Map<string, FlowEdge[]>();
  for (const edge of chart.edges) {
    if (!canvasIdOf.has(edge.from) || !canvasIdOf.has(edge.to)) continue;
    const key = `${edge.from}\n${edge.to}`;
    if (!waiting.has(key)) waiting.set(key, []);
    waiting.get(key)!.push(edge);
  }

  const keptEdges: AnyObj[] = [];
  for (const old of oldEdges) {
    if (!keptIds.has(old.fromNode) || !keptIds.has(old.toNode)) { result.linesRemoved++; continue; }
    const view = exportedEdge(old);
    const from = nameOf.get(view.from), to = nameOf.get(view.to);
    // A line to a locked card that isn't in the code stays as it is.
    if (!from || !to) { keptEdges.push(old); continue; }

    const queue = waiting.get(`${from}\n${to}`);
    if (!queue?.length) { result.linesRemoved++; continue; }
    const same = queue.findIndex(e => e.label === view.label);
    const want = queue.splice(same >= 0 ? same : 0, 1)[0];

    const edge = { ...old };
    let touched = false;
    if (want.label !== view.label) {
      setOrDelete(edge, "label", want.label);
      delete edge.canvasflowLabels;
      touched = true;
    }
    if (want.startArrow !== view.startArrow || want.endArrow !== view.endArrow) {
      const atCanvasFrom = view.flipped ? want.endArrow : want.startArrow;
      const atCanvasTo = view.flipped ? want.startArrow : want.endArrow;
      setOrDelete(edge, "fromEnd", atCanvasFrom ? "arrow" : undefined);
      setOrDelete(edge, "toEnd", atCanvasTo ? undefined : "none");
      touched = true;
    }
    // linkStyle can make a line thick or dashed too.
    const styled = strokeOptions(want.styles, 2) ?? {};
    const stroke = want.stroke !== "normal" ? want.stroke
      : styled.style ? "dotted" : (styled.width ?? 2) >= 4 ? "thick" : "normal";
    if (stroke !== view.stroke) {
      const line = { ...(edge.canvasflowLine ?? {}) };
      if (stroke === "dotted") line.style = "dotted";
      else delete line.style;
      if (stroke === "thick" && (line.width ?? 2) < 4) line.width = 4;
      if (stroke === "normal" && (line.width ?? 2) >= 4) delete line.width;
      setOrDelete(edge, "canvasflowLine", Object.keys(line).length ? line : undefined);
      touched = true;
    }
    const color = canvasColor(want.styles);
    if (color !== currentColor(edge)) { setOrDelete(edge, "color", color); touched = true; }
    if (touched) result.updated++;
    keptEdges.push(edge);
  }

  const newEdges: AnyObj[] = [];
  for (const queue of waiting.values()) {
    for (const want of queue) {
      const [fromSide, toSide] = sidesFor(rects.get(want.from)!, rects.get(want.to)!, chart.direction);
      const line: AnyObj = {
        id: newId(),
        fromNode: canvasIdOf.get(want.from), fromSide,
        toNode: canvasIdOf.get(want.to), toSide,
      };
      if (want.startArrow) line.fromEnd = "arrow";
      if (!want.endArrow) line.toEnd = "none";
      if (want.label) line.label = want.label;
      const color = canvasColor(want.styles);
      if (color) line.color = color;
      const style: AnyObj = strokeOptions(want.styles, 2) ?? {};
      if (want.stroke === "dotted" && !style.style) style.style = "dotted";
      if (want.stroke === "thick" && !style.width) style.width = 4;
      if (Object.keys(style).length) line.canvasflowLine = style;
      newEdges.push(line);
    }
  }
  result.linesAdded = newEdges.length;

  result.changed = result.cardsAdded + result.cardsRemoved + result.linesAdded + result.linesRemoved + result.updated > 0;
  if (!result.changed) return result;

  // Save every card's name, so the code written against it keeps pointing at it.
  for (const node of keptNodes) {
    const name = names.get(node.id);
    if (name) node[MERMAID_ID_KEY] = name;
  }
  result.data = {
    ...data,
    nodes: [...newGroups, ...keptNodes, ...newCards],
    edges: [...keptEdges, ...newEdges],
  };
  return result;
}
