import { Menu, addIcon, setIcon, setTooltip } from "obsidian";
import { Box, Point, SIDE_DIR, Side, routeElbow } from "./elbowRoute";

/**
 * Extra options for the lines (edges) between cards:
 *
 * - Style (solid, dashed, dotted) and thickness, per line. Stored on the edge
 *   as `canvasflowLine: { style?, width? }`. Obsidian keeps unknown keys on
 *   edges, so this survives reloads, copy/paste and undo/redo.
 * - Path (curved, straight, elbow), for the whole canvas. Stored at the top
 *   level of the .canvas file as `canvasflowLinePath`, which Obsidian also
 *   keeps. Changed from a button in the bar at the bottom of the canvas.
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
function registerIcons() {
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


type AnyObj = any;
type PatchProto = (proto: AnyObj, method: string, wrap: (orig: (...a: any[]) => any) => (...a: any[]) => any) => void;

export class LineTools {
  constructor(private patchProto: PatchProto, private register: (cb: () => void) => void) {
    registerIcons();
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
      return result;
    });

    // updatePath() runs on every card move; redraw the line as straight or elbow.
    this.patchProto(proto, "updatePath", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try { self.reroute(this); } catch (err) { console.error("[CanvasFlow] line path", err); }
      return result;
    });

    this.applyStyle(edge);
    try { if (edge.initialized) edge.updatePath?.(); } catch {}
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
    if (path === "curved" || !bezier || !fromSide || !toSide || !SIDE_DIR[fromSide] || !SIDE_DIR[toSide]) return;

    const s: Point = bezier.from;
    const c: Point = bezier.to;
    const fromDir = SIDE_DIR[fromSide];
    const toDir = SIDE_DIR[toSide];
    // The points on the cards themselves.
    const a = add(s, fromDir, -END_GAP);
    const l = add(c, toDir, -END_GAP);
    const fromEnd = edge.fromLineEnd;
    const toEnd = edge.toLineEnd;

    let points: Point[];
    if (path === "straight") {
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
      const boxes = [edge.from.node.getBBox?.(), edge.to.node.getBBox?.()].filter(Boolean) as Box[];
      // Arrowheads keep Obsidian's placement: they already face the card's side.
      points = routeElbow(fromEnd ? s : a, p1, p2, toEnd ? c : l, boxes);
    }

    points = dedupe(points);
    const d = points.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join(" ");
    edge.path.interaction?.setAttribute("d", d);
    edge.path.display?.setAttribute("d", d);

    // The label sits at bezier(0.5). Bend the control points so that lands on
    // the middle of our line: B(0.5) = (from + 3·cp1 + 3·cp2 + to) / 8.
    const mid = midpoint(points);
    const cp = { x: (8 * mid.x - s.x - c.x) / 6, y: (8 * mid.y - s.y - c.y) / 6 };
    edge.bezier = { ...bezier, cp1: cp, cp2: cp, path: d };
    try { edge.labelElement?.render?.(); } catch {}
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
      const menu = new Menu();
      for (const [value, label, icon] of STYLES) {
        menu.addItem(item => item
          .setTitle(label)
          .setIcon(icon)
          .setChecked(options.every(o => styleOf(o) === value))
          .onClick(() => update(o => ({ ...o, style: value === "solid" ? undefined : value }))));
      }
      menu.addSeparator();
      for (const [value, label] of WIDTHS) {
        menu.addItem(item => item
          .setTitle(label)
          .setIcon(`canvasflow-width-${value}`)
          .setChecked(options.every(o => widthOf(o) === value))
          .onClick(() => update(o => ({ ...o, width: value }))));
      }
      const rect = button.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
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

// ---------- geometry ----------

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
