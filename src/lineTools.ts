import { Menu, addIcon, setIcon, setTooltip } from "obsidian";
import { Box, Point, SIDE_DIR, Side, alignFacingEnds, routeElbow } from "./elbowRoute";
import { POINTED_SIDES, SHAPE_KEY } from "./shapeGeometry";
import { LineLabels } from "./lineLabels";

/**
 * Extra options for the lines (edges) between cards:
 *
 * - Style (solid, dashed, dotted) and thickness, per line. Stored on the edge
 *   as `canvasflowLine: { style?, width? }`. Obsidian keeps unknown keys on
 *   edges, so this survives reloads, copy/paste and undo/redo.
 * - Path (curved, straight, elbow), for the whole canvas. Stored at the top
 *   level of the .canvas file as `canvasflowLinePath`, which Obsidian also
 *   keeps. Changed from a button in the bar at the bottom of the canvas.
 * - Labels that can be moved, and more than one per line (see lineLabels.ts).
 * - Elbow lines whose middle stretch can be dragged to move the bend. Stored
 *   on the edge as `canvasflowBend`.
 *
 * Like the card tools, every hook is defensive: Obsidian's canvas internals
 * are not public API.
 */

export type LineStyle = "solid" | "dashed" | "dotted";
export type LinePath = "curved" | "straight" | "elbow";

export interface LineOptions {
  style?: Exclude<LineStyle, "solid">;
  width?: number;
}

const LINE_KEY = "canvasflowLine";
const PATH_KEY = "canvasflowLinePath";
const PATH_BUTTON_CLASS = "canvasflow-line-path";

/** Obsidian's default line is 2px. */
const DEFAULT_WIDTH = 2;
const WIDTHS: Array<[number, string]> = [[1, "Thin"], [2, "Medium"], [4, "Thick"], [6, "Extra thick"]];
const STYLES: Array<[LineStyle, string, string]> = [
  ["solid", "Solid", "canvasflow-line-solid"],
  ["dashed", "Dashed", "canvasflow-line-dashed"],
  ["dotted", "Dotted", "canvasflow-line-dotted"],
];

/** Small line icons for the menus (Obsidian icons use a 100x100 box). */
let iconsRegistered = false;
function registerIcons() {
  if (iconsRegistered) return;
  iconsRegistered = true;
  const line = (extra: string, width = 8) =>
    `<line x1="12" y1="50" x2="88" y2="50" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" ${extra}/>`;
  addIcon("canvasflow-line-solid", line(""));
  addIcon("canvasflow-line-dashed", line('stroke-dasharray="18 14" stroke-linecap="butt"'));
  addIcon("canvasflow-line-dotted", line('stroke-dasharray="0 16"', 10));
  for (const [width] of WIDTHS) addIcon(`canvasflow-width-${width}`, line("", width * 4));
}
const PATHS: Array<[LinePath, string, string]> = [
  ["curved", "Curved lines", "spline"],
  ["straight", "Straight lines", "slash"],
  ["elbow", "Elbow lines", "corner-down-right"],
];

/** Obsidian starts and ends lines this far out from the card (room for the arrowhead). */
const END_GAP = 7;
/** Elbow lines leave the card straight for at least this long before turning. */
const ELBOW_LEAD = 24;
/** Where an elbow line's middle stretch was dragged to: `canvasflowBend: { at? , out? }` on the edge. */
const BEND_KEY = "canvasflowBend";
const BEND_HANDLE_CLASS = "canvasflow-bend-handle";
const BEND_HANDLE = Symbol("canvasflowBendHandle");
/** Screen pixels: a press must move this far to count as a drag; the bend snaps to the middle within this. */
const BEND_DRAG_THRESHOLD = 4;
const BEND_SNAP = 6;
/** How far past the cards a U-shaped line's bend can be pulled. */
const BEND_MAX_OUT = 2000;

/**
 * The stretch of an elbow line that can be dragged: the one in the middle,
 * at right angles to both ends. `value` is where it sits on `axis`.
 */
interface Bend {
  axis: "x" | "y";
  min: number;
  max: number;
  /** Snap here when dragged close (the middle of a Z-shaped line). */
  snap?: number;
  /** The stored position as a coordinate, or null when there is none. */
  value: number | null;
  /** What to store for a coordinate. */
  store: (value: number) => { at: number } | { out: number };
}


type AnyObj = any;
type PatchProto = (proto: AnyObj, method: string, wrap: (orig: (...a: any[]) => any) => (...a: any[]) => any) => void;

export class LineTools {
  private labels: LineLabels;
  private bendHandles = new Set<SVGPathElement>();

  constructor(private patchProto: PatchProto, private register: (cb: () => void) => void) {
    registerIcons();
    this.labels = new LineLabels(patchProto, register);
    register(() => {
      for (const handle of this.bendHandles) handle.remove();
      this.bendHandles.clear();
    });
  }

  /** Hook a canvas: edges added later (drawn, pasted, undo) and the bottom-bar button. */
  patchCanvas(canvas: AnyObj) {
    const self = this;
    this.patchProto(Object.getPrototypeOf(canvas), "addEdge", orig => function (this: AnyObj, edge: AnyObj, ...rest: any[]) {
      const result = orig.call(this, edge, ...rest);
      self.watchEdge(edge);
      return result;
    });
    this.applyAll(canvas);
    this.addPathButton(canvas);
  }

  applyAll(canvas: AnyObj) {
    for (const edge of this.getEdges(canvas)) this.watchEdge(edge);
  }

  // ---------- data ----------

  isEdge(item: AnyObj): boolean {
    return !!item?.path?.display && !!item?.from?.node && !!item?.to?.node;
  }

  private getEdges(canvas: AnyObj): AnyObj[] {
    return canvas?.edges instanceof Map ? Array.from(canvas.edges.values()) : [];
  }

  private getOptions(edge: AnyObj): LineOptions {
    try { return { ...(edge.getData?.()?.[LINE_KEY] ?? {}) }; } catch { return {}; }
  }

  private setOptions(edge: AnyObj, options: LineOptions) {
    const clean: LineOptions = {};
    if (options.style) clean.style = options.style;
    if (options.width && options.width !== DEFAULT_WIDTH) clean.width = options.width;

    const next = { ...edge.getData() };
    if (Object.keys(clean).length) next[LINE_KEY] = clean;
    else delete next[LINE_KEY];
    edge.setData(next);
    this.applyStyle(edge);
  }

  private getPath(canvas: AnyObj): LinePath {
    const value = canvas?.data?.[PATH_KEY];
    return value === "straight" || value === "elbow" ? value : "curved";
  }

  private setPath(canvas: AnyObj, path: LinePath) {
    if (!canvas || this.getPath(canvas) === path) return;
    const data = { ...(canvas.data ?? {}) };
    if (path === "curved") delete data[PATH_KEY];
    else data[PATH_KEY] = path;
    canvas.data = data;

    for (const edge of this.getEdges(canvas)) {
      try { edge.render?.(); } catch {}
    }
    this.updatePathButton(canvas);
    try { canvas.pushHistory?.(canvas.getData()); } catch {}
    try { canvas.requestSave?.(); } catch {}
  }

  // ---------- rendering ----------

  private watchEdge(edge: AnyObj) {
    if (!edge) return;
    const self = this;
    const proto = Object.getPrototypeOf(edge);

    // render() runs on data changes (color, ends, our options) and calls updatePath().
    this.patchProto(proto, "render", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try { self.applyStyle(this); } catch {}
      try { self.updatePathButton(this.canvas); } catch {}
      try { self.labels.sync(this); } catch (err) { console.error("[CanvasFlow] line labels", err); }
      return result;
    });

    // updatePath() runs on every card move; redraw the line as straight or elbow.
    this.patchProto(proto, "updatePath", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try { self.reroute(this); } catch (err) { console.error("[CanvasFlow] line path", err); }
      try { self.labels.layout(this); } catch {}
      return result;
    });

    this.applyStyle(edge);
    try { if (edge.initialized) edge.updatePath?.(); } catch {}
    try { this.labels.watchEdge(edge); } catch (err) { console.error("[CanvasFlow] line labels", err); }
  }

  /** Mirror the line's options onto its SVG groups for styles.css. */
  private applyStyle(edge: AnyObj) {
    const options = this.getOptions(edge);
    const width = options.width && options.width !== DEFAULT_WIDTH ? options.width : null;
    for (const el of [edge.lineGroupEl, edge.lineEndGroupEl] as Array<SVGElement | undefined>) {
      if (!el) continue;
      if (options.style) el.setAttribute("data-canvasflow-line-style", options.style);
      else el.removeAttribute("data-canvasflow-line-style");
      if (width) {
        el.setAttribute("data-canvasflow-line-width", String(width));
        el.style.setProperty("--canvasflow-line-width", `${width}px`);
        // Arrowheads grow with the line, but more slowly.
        el.style.setProperty("--canvasflow-arrow-scale", String(Math.max(0.75, 1 + (width - DEFAULT_WIDTH) * 0.25)));
      } else {
        el.removeAttribute("data-canvasflow-line-width");
        el.style.removeProperty("--canvasflow-line-width");
        el.style.removeProperty("--canvasflow-arrow-scale");
      }
    }
  }

  /**
   * Replace Obsidian's curve with a straight or elbow line. Obsidian has
   * already placed everything for the curve; we reuse its end points
   * (`bezier.from`/`to`, which sit END_GAP out from each card) and sides.
   */
  private reroute(edge: AnyObj) {
    const path = this.getPath(edge.canvas);
    const bezier = edge.bezier;
    const fromSide: Side | undefined = edge.from?.side;
    const toSide: Side | undefined = edge.to?.side;
    if (path === "curved" || !bezier || !fromSide || !toSide || !SIDE_DIR[fromSide] || !SIDE_DIR[toSide]) {
      this.placeBendHandle(edge, null);
      return;
    }

    const fromDir = SIDE_DIR[fromSide];
    const toDir = SIDE_DIR[toSide];
    const fromEnd = edge.fromLineEnd;
    const toEnd = edge.toLineEnd;
    // The points on the cards themselves.
    let a = add(bezier.from, fromDir, -END_GAP);
    let l = add(bezier.to, toDir, -END_GAP);

    // Facing ends that nearly line up are nudged along their sides until they do.
    const fromBox: Box | undefined = edge.from.node.getBBox?.();
    const toBox: Box | undefined = edge.to.node.getBBox?.();
    const aligned = alignFacingEnds(
      { point: a, side: fromSide, box: fromBox, fixed: isPointed(edge.from.node, fromSide) },
      { point: l, side: toSide, box: toBox, fixed: isPointed(edge.to.node, toSide) },
      (fromEnd ? END_GAP : 0) + (toEnd ? END_GAP : 0),
    );
    if (aligned) {
      a = aligned.from;
      l = aligned.to;
    }
    // Where the line starts and ends when there's an arrowhead.
    const s = add(a, fromDir, END_GAP);
    const c = add(l, toDir, END_GAP);

    let points: Point[];
    // The stretch of an elbow line that can be dragged, if it has one.
    let handle: { bend: Bend; from: Point; to: Point } | null = null;
    if (aligned && path === "elbow") {
      if (fromEnd?.el) fromEnd.el.style.transform = arrowTransform(a, -fromDir.x, -fromDir.y);
      if (toEnd?.el) toEnd.el.style.transform = arrowTransform(l, -toDir.x, -toDir.y);
      points = [fromEnd ? s : a, toEnd ? c : l];
    } else if (path === "straight") {
      const toward = unit(l.x - a.x, l.y - a.y);
      // Leave room for arrowheads, and point them along the line.
      const start = fromEnd ? add(a, toward, END_GAP) : a;
      const end = toEnd ? add(l, toward, -END_GAP) : l;
      if (fromEnd?.el) fromEnd.el.style.transform = arrowTransform(a, -toward.x, -toward.y);
      if (toEnd?.el) toEnd.el.style.transform = arrowTransform(l, toward.x, toward.y);
      points = [start, end];
    } else {
      const p1 = add(s, fromDir, ELBOW_LEAD);
      const p2 = add(c, toDir, ELBOW_LEAD);
      const boxes = [fromBox, toBox].filter(Boolean) as Box[];
      // Arrowheads keep Obsidian's placement: they already face the card's side.
      const start = fromEnd ? s : a;
      const end = toEnd ? c : l;
      points = routeElbow(start, p1, p2, end, boxes);

      const bend = getBend(edge, fromDir, toDir, p1, p2);
      if (bend) {
        const { axis } = bend;
        const across = axis === "x" ? "y" : "x";
        if (bend.value !== null) {
          // Dragged: both ends stay put, only the middle stretch moves.
          const value = Math.min(bend.max, Math.max(bend.min, bend.value));
          const m1 = { ...start, [axis]: value } as Point;
          const m2 = { ...end, [axis]: value } as Point;
          points = [start, m1, m2, end];
          handle = { bend, from: m1, to: m2 };
        } else if (
          points.length === 4 &&
          Math.abs(points[1][axis] - points[2][axis]) < 0.01 &&
          Math.abs(points[1][across] - points[2][across]) > 0.5
        ) {
          handle = { bend, from: points[1], to: points[2] };
        }
      }
    }
    this.placeBendHandle(edge, handle);

    points = dedupe(points);
    const d = points.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join(" ");
    edge.path.interaction?.setAttribute("d", d);
    edge.path.display?.setAttribute("d", d);

    // Unless it's been moved, the label sits at bezier(0.5). Bend the control points so that lands on
    // the middle of our line: B(0.5) = (from + 3·cp1 + 3·cp2 + to) / 8.
    const mid = midpoint(points);
    const cp = { x: (8 * mid.x - bezier.from.x - bezier.to.x) / 6, y: (8 * mid.y - bezier.from.y - bezier.to.y) / 6 };
    edge.bezier = { ...bezier, cp1: cp, cp2: cp, path: d };
    try { edge.labelElement?.render?.(); } catch {}
  }

  // ---------- dragging the bend ----------

  /** Put the invisible grab strip over the middle stretch of an elbow line, or take it away. */
  private placeBendHandle(edge: AnyObj, handle: { bend: Bend; from: Point; to: Point } | null) {
    let el: SVGPathElement | undefined = edge[BEND_HANDLE];
    if (!handle || !edge.lineGroupEl) {
      if (el) {
        el.remove();
        this.bendHandles.delete(el);
        delete edge[BEND_HANDLE];
      }
      return;
    }
    if (!el || !this.bendHandles.has(el)) {
      el = (edge.lineGroupEl as SVGElement).ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      el.classList.add(BEND_HANDLE_CLASS);
      edge[BEND_HANDLE] = el;
      this.bendHandles.add(el);
      this.wireBendDrag(edge, el);
    }
    if (el.parentNode !== edge.lineGroupEl) edge.lineGroupEl.appendChild(el);
    el.setAttribute("d", `M${round(handle.from.x)} ${round(handle.from.y)} L${round(handle.to.x)} ${round(handle.to.y)}`);
    el.dataset.axis = handle.bend.axis;
    (el as AnyObj).canvasflowBend = { bend: handle.bend, value: handle.from[handle.bend.axis] };
  }

  /** Drag the middle stretch sideways. A press that doesn't move stays a click (which selects the line). */
  private wireBendDrag(edge: AnyObj, el: SVGPathElement) {
    let suppressClick = false;
    el.addEventListener("click", evt => {
      if (!suppressClick) return;
      suppressClick = false;
      evt.preventDefault();
      evt.stopImmediatePropagation();
    });

    el.addEventListener("pointerdown", (down: PointerEvent) => {
      const canvas = edge.canvas;
      const current: { bend: Bend; value: number } | undefined = (el as AnyObj).canvasflowBend;
      if (!down.isPrimary || down.button !== 0 || !canvas || canvas.readonly || !current) return;
      // Otherwise Obsidian would pull the nearer end off its card.
      down.stopPropagation();
      down.preventDefault();
      suppressClick = false;

      const doc = el.ownerDocument;
      const { bend, value: startValue } = current;
      const pointer: Point = canvas.posFromEvt(down);
      if (!pointer) return;
      const before = JSON.stringify(edge.unknownData?.[BEND_KEY] ?? null);
      let dragging = false;

      const move = (evt: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(evt.clientX - down.clientX, evt.clientY - down.clientY) < BEND_DRAG_THRESHOLD) return;
          dragging = true;
          el.classList.add("is-dragging");
          try { if (!canvas.selection?.has(edge)) canvas.selectOnly?.(edge); } catch {}
        }
        evt.preventDefault();
        const at: Point = canvas.posFromEvt(evt);
        let value = startValue + at[bend.axis] - pointer[bend.axis];
        value = Math.min(bend.max, Math.max(bend.min, value));
        const snap = BEND_SNAP / (canvas.scale || 1);
        if (bend.snap !== undefined && Math.abs(value - bend.snap) <= snap) value = bend.snap;
        edge.unknownData = { ...(edge.unknownData ?? {}), [BEND_KEY]: bend.store(value) };
        try { edge.updatePath?.(); } catch {}
      };
      const end = () => {
        doc.removeEventListener("pointermove", move, true);
        doc.removeEventListener("pointerup", end, true);
        doc.removeEventListener("pointercancel", end, true);
        if (!dragging) return;
        el.classList.remove("is-dragging");
        suppressClick = true;
        doc.defaultView?.setTimeout(() => { suppressClick = false; }, 0);
        if (JSON.stringify(edge.unknownData?.[BEND_KEY] ?? null) !== before) {
          try { canvas.requestSave?.(); } catch {}
        }
      };
      doc.addEventListener("pointermove", move, true);
      doc.addEventListener("pointerup", end, true);
      doc.addEventListener("pointercancel", end, true);
    });
  }

  // ---------- action bar ----------

  /** Add the "Line style" button when the selection includes lines. */
  renderButtons(canvas: AnyObj, insert: (btn: HTMLElement) => void, makeButton: (icon: string, label: string, active?: boolean) => HTMLButtonElement) {
    const selection: AnyObj[] = Array.from(canvas?.selection ?? []);
    const edges = selection.filter(item => this.isEdge(item));
    if (!edges.length) return;

    const options = edges.map(e => this.getOptions(e));
    const styleOf = (o: LineOptions): LineStyle => o.style ?? "solid";
    const widthOf = (o: LineOptions) => o.width ?? DEFAULT_WIDTH;
    const customized = options.some(o => o.style || (o.width && o.width !== DEFAULT_WIDTH));

    const update = (change: (o: LineOptions) => LineOptions) => {
      for (const edge of edges) this.setOptions(edge, change(this.getOptions(edge)));
      try { canvas.pushHistory?.(canvas.getData()); } catch {}
      try { canvas.requestSave?.(); } catch {}
      try { canvas.menu?.render?.(); } catch {}
    };

    const button = makeButton("pencil-line", edges.length > 1 ? "Line styles" : "Line style", customized);
    button.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      showStrokeMenu(button, options.map(o => ({ style: styleOf(o), width: widthOf(o) })), choice =>
        update(o => ({
          ...o,
          ...(choice.style ? { style: choice.style === "solid" ? undefined : choice.style } : {}),
          ...(choice.width ? { width: choice.width } : {}),
        })));
    });
    insert(button);
  }

  // ---------- bottom bar ----------

  /** The curved / straight / elbow button in the bar at the bottom of the canvas. */
  private addPathButton(canvas: AnyObj) {
    const bar: HTMLElement | undefined = canvas.cardMenuEl ?? canvas.wrapperEl?.querySelector?.(".canvas-card-menu");
    if (!bar || bar.querySelector(`.${PATH_BUTTON_CLASS}`)) return;

    const button = document.createElement("div");
    button.className = `canvas-card-menu-button ${PATH_BUTTON_CLASS}`;
    button.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      const current = this.getPath(canvas);
      const menu = new Menu();
      for (const [value, label, icon] of PATHS) {
        menu.addItem(item => item
          .setTitle(label)
          .setIcon(icon)
          .setChecked(current === value)
          .onClick(() => this.setPath(canvas, value)));
      }
      const rect = button.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.top - 4 }, button.ownerDocument);
    });
    bar.appendChild(button);
    this.register(() => button.remove());
    this.updatePathButton(canvas);
  }

  /** Show the current path type on the bottom-bar button (also after undo). */
  updatePathButton(canvas: AnyObj) {
    const bar: HTMLElement | undefined = canvas.cardMenuEl ?? canvas.wrapperEl?.querySelector?.(".canvas-card-menu");
    const button = bar?.querySelector<HTMLElement>(`.${PATH_BUTTON_CLASS}`);
    if (!button) return;
    const path = this.getPath(canvas);
    if (button.dataset.path === path) return;
    const [, label, icon] = PATHS.find(([value]) => value === path) ?? PATHS[0];
    button.dataset.path = path;
    button.empty();
    setIcon(button, icon);
    button.setAttribute("aria-label", `Line shape: ${label.toLowerCase()}`);
    setTooltip(button, `Line shape: ${label.toLowerCase()}`, { placement: "top" });
  }
}

// ---------- shared menu ----------

/**
 * The style and thickness menu, shared by lines and shape outlines.
 * `current` holds each selected item's style and width; a choice reports
 * only what was picked.
 */
export function showStrokeMenu(
  anchor: HTMLElement,
  current: Array<{ style: LineStyle; width: number }>,
  onPick: (choice: { style?: LineStyle; width?: number }) => void,
) {
  registerIcons();
  const menu = new Menu();
  for (const [value, label, icon] of STYLES) {
    menu.addItem(item => item
      .setTitle(label)
      .setIcon(icon)
      .setChecked(current.every(c => c.style === value))
      .onClick(() => onPick({ style: value })));
  }
  menu.addSeparator();
  for (const [value, label] of WIDTHS) {
    menu.addItem(item => item
      .setTitle(label)
      .setIcon(`canvasflow-width-${value}`)
      .setChecked(current.every(c => c.width === value))
      .onClick(() => onPick({ width: value })));
  }
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
}

// ---------- geometry ----------

/** Does this card's shape come to a point in the middle of `side`? */
function isPointed(node: AnyObj, side: Side): boolean {
  try {
    const id = node?.getData?.()?.[SHAPE_KEY];
    return typeof id === "string" && !!(POINTED_SIDES as Record<string, string[]>)[id]?.includes(side);
  } catch { return false; }
}

/**
 * Whether an elbow line between these two sides has a middle stretch that can
 * be dragged, and where. Only lines whose ends run the same way do: left or
 * right sides at both ends (a vertical middle stretch, moved along x), or top
 * or bottom at both (a horizontal one, moved along y).
 *
 * - Sides facing opposite ways (a Z): the bend sits between the two leads,
 *   stored as `at`, a fraction of the way from the first lead to the second,
 *   so it keeps its place as the cards move.
 * - Sides facing the same way (a U): the bend sits beyond both leads, stored
 *   as `out`, the distance past the farther one.
 */
function getBend(edge: AnyObj, fromDir: Point, toDir: Point, p1: Point, p2: Point): Bend | null {
  const axis = fromDir.x !== 0 && toDir.x !== 0 ? "x" : fromDir.y !== 0 && toDir.y !== 0 ? "y" : null;
  if (!axis) return null;
  const across = axis === "x" ? "y" : "x";
  // In line with each other: nothing to bend.
  if (Math.abs(p1[across] - p2[across]) < 0.5) return null;

  const a1 = p1[axis];
  const a2 = p2[axis];
  const dir = fromDir[axis];
  const stored = edge.unknownData?.[BEND_KEY];
  const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  if (dir === toDir[axis]) {
    const outer = dir > 0 ? Math.max(a1, a2) : Math.min(a1, a2);
    const far = outer + dir * BEND_MAX_OUT;
    const out = number(stored?.out);
    return {
      axis,
      min: Math.min(outer, far),
      max: Math.max(outer, far),
      value: out === null ? null : outer + dir * Math.max(0, out),
      store: value => ({ out: round(Math.max(0, (value - outer) * dir)) }),
    };
  }

  // The second card has to be far enough ahead of the first for a Z to fit.
  const span = a2 - a1;
  if (span * dir < 1) return null;
  const at = number(stored?.at);
  return {
    axis,
    min: Math.min(a1, a2),
    max: Math.max(a1, a2),
    snap: (a1 + a2) / 2,
    value: at === null ? null : a1 + span * Math.min(1, Math.max(0, at)),
    store: value => ({ at: Math.round(((value - a1) / span) * 10000) / 10000 }),
  };
}

function add(p: Point, dir: Point, length: number): Point {
  return { x: p.x + dir.x * length, y: p.y + dir.y * length };
}

function unit(x: number, y: number): Point {
  const length = Math.hypot(x, y);
  return length ? { x: x / length, y: y / length } : { x: 0, y: 1 };
}

/** Arrowheads point "up" at 0deg; rotate one to point along (dx, dy), its tip at `tip`. */
function arrowTransform(tip: Point, dx: number, dy: number): string {
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return `translate(${round(tip.x)}px, ${round(tip.y)}px) rotate(${round(angle)}deg)`;
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.01);
}

/** The point halfway along a polyline. */
function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let remaining = lengths.reduce((sum, len) => sum + len, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) {
      const t = remaining / lengths[i];
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    remaining -= lengths[i];
  }
  return points[points.length - 1];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
