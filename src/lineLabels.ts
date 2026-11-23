import { Point } from "./elbowRoute";

/**
 * Labels on lines:
 *
 * - Any label can be dragged anywhere along its line, or off it to sit just
 *   above, below or beside it. A position is a fraction of the way along the
 *   line (`at`) and, for labels off the line, which side they're on (`side`),
 *   so labels follow the line when cards move. Off the line a label always
 *   sits right next to it; it can't be left further away.
 * - A line can have more than one label. The first is Obsidian's own
 *   (`label` on the edge); its position is stored as `canvasflowLabelPos`.
 *   The rest are stored as `canvasflowLabels: [{ text, at, side? }]` and
 *   drawn here with Obsidian's label classes, so they look the same.
 *
 * Double-clicking a line adds a label where you clicked.
 */

export interface LabelPos {
  at: number;
  /** Off the line: 1 is to the right of the line's direction of travel, -1 to the left. */
  side?: 1 | -1;
}

interface ExtraLabel extends LabelPos {
  text: string;
}

interface Handle {
  wrapperEl: HTMLElement;
  textEl: HTMLElement;
  editing: boolean;
  initialText: string;
}

const POS_KEY = "canvasflowLabelPos";
const LABELS_KEY = "canvasflowLabels";
const EXTRA_CLASS = "canvasflow-label";
/** Per-edge list of extra label elements, stored on the edge object. */
const HANDLES = "__canvasflowLabels";
/** Marks a native label whose wrapper already has our drag listeners. */
const WIRED = "__canvasflowLabelWired";

/** Pointer movement (screen px) before a press on a label becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Within this many screen px a dragged label snaps onto the line, or to its middle. Further out it sits beside the line. */
const SNAP = 8;
/** Space between the line and a label beside it, in canvas units. */
const SIDE_GAP = 2;

type AnyObj = any;
type PatchProto = (proto: AnyObj, method: string, wrap: (orig: (...a: any[]) => any) => (...a: any[]) => any) => void;

export class LineLabels {
  private edges = new Set<AnyObj>();
  /** Removes every listener we add to Obsidian's own labels when the plugin unloads. */
  private abort = new AbortController();
  /** Labels beside a line sit a box-width away, so re-place them when their size changes (typing, zooming). */
  private sizes = new WeakMap<Element, AnyObj>();
  private resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
    const edges = new Set<AnyObj>();
    for (const entry of entries) {
      const edge = this.sizes.get(entry.target);
      if (edge) edges.add(edge);
    }
    for (const edge of edges) {
      try { this.layout(edge); } catch {}
    }
  });

  constructor(private patchProto: PatchProto, register: (cb: () => void) => void) {
    register(() => {
      this.abort.abort();
      this.resizes?.disconnect();
      for (const edge of this.edges) this.removeHandles(edge);
      this.edges.clear();
    });
  }

  /** Patch the edge class (once) for clicks, deselection and removal. */
  watchEdge(edge: AnyObj) {
    const self = this;
    const proto = Object.getPrototypeOf(edge);

    // Double-clicking a line adds a label at that spot. The first click selects
    // the line as usual; a single click on a selected line leaves it as it is
    // (Obsidian would start a label).
    this.patchProto(proto, "onClick", orig => function (this: AnyObj, evt: MouseEvent, ...rest: any[]) {
      const canvas = this.canvas;
      if (evt?.button === 0 && !evt.shiftKey && canvas && !canvas.readonly && canvas.selection?.size === 1 && canvas.selection.has(this)) {
        if (evt.detail < 2) return;
        try {
          if (self.addAt(this, evt)) return;
        } catch (err) { console.error("[CanvasFlow] add label", err); }
      }
      return orig.call(this, evt, ...rest);
    });

    this.patchProto(proto, "editLabel", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try {
        self.wireNative(this);
        self.placeNative(this);
      } catch {}
      return result;
    });

    // Deselecting a line ends label editing.
    this.patchProto(proto, "blur", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try {
        for (const handle of self.handles(this).slice()) self.finishEditing(this, handle);
        self.dropStalePos(this);
      } catch {}
      return result;
    });

    this.patchProto(proto, "destroy", orig => function (this: AnyObj, ...args: any[]) {
      try {
        self.removeHandles(this);
        self.edges.delete(this);
      } catch {}
      return orig.apply(this, args);
    });

    this.sync(edge);
  }

  /** Match the label elements to the line's data. Runs after every render (edits, undo, redo). */
  sync(edge: AnyObj) {
    this.wireNative(edge);
    this.dropStalePos(edge);

    const list = this.getExtras(edge);
    const handles = this.handles(edge);
    if (!list.length && !handles.length) {
      this.placeNative(edge);
      return;
    }

    while (handles.length > list.length) handles.pop()?.wrapperEl.remove();
    while (handles.length < list.length) handles.push(this.createHandle(edge));
    edge[HANDLES] = handles;
    this.edges.add(edge);

    // Labels saved or left empty are dropped, like Obsidian's own.
    for (let i = handles.length - 1; i >= 0; i--) {
      if (!handles[i].editing && !list[i].text.trim()) this.removeExtra(edge, handles[i]);
    }

    const current = this.getExtras(edge);
    handles.forEach((handle, i) => {
      if (!handle.editing && handle.textEl.innerText !== current[i].text) handle.textEl.setText(current[i].text);
      this.copyColor(edge, handle.wrapperEl);
    });
    this.layout(edge);
  }

  /** Put every label where it belongs on the line as drawn now. Runs on every card move. */
  layout(edge: AnyObj) {
    this.placeNative(edge);
    const handles = this.handles(edge);
    if (!handles.length) return;
    const list = this.getExtras(edge);
    handles.forEach((handle, i) => {
      const point = list[i] ? this.pointFor(edge, list[i], handle.textEl) : null;
      if (point) handle.wrapperEl.style.transform = `translate(${round(point.x)}px, ${round(point.y)}px)`;
    });
  }

  // ---------- data ----------

  private read(edge: AnyObj, key: string): unknown {
    try {
      return edge.unknownData ? edge.unknownData[key] : edge.getData?.()?.[key];
    } catch { return undefined; }
  }

  /** Write an extra key on the edge; `undefined` removes it. */
  private write(edge: AnyObj, key: string, value: unknown) {
    const next = { ...(edge.unknownData ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    edge.unknownData = next;
  }

  private getPos(edge: AnyObj): LabelPos | null {
    return cleanPos(this.read(edge, POS_KEY));
  }

  private setPos(edge: AnyObj, pos: LabelPos | null) {
    this.write(edge, POS_KEY, pos && !isMiddle(pos) ? pos : undefined);
  }

  private getExtras(edge: AnyObj): ExtraLabel[] {
    const stored = this.read(edge, LABELS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(item => item && typeof item === "object" && typeof item.text === "string")
      .map(item => ({ text: item.text, ...(cleanPos(item) ?? { at: 0.5 }) }));
  }

  private setExtras(edge: AnyObj, list: ExtraLabel[]) {
    this.write(edge, LABELS_KEY, list.length ? list : undefined);
  }

  /** A position left behind by a label that's gone shouldn't apply to the next one. */
  private dropStalePos(edge: AnyObj) {
    if (!edge.label && !edge.labelElement && this.read(edge, POS_KEY) !== undefined) this.write(edge, POS_KEY, undefined);
  }

  private watchSize(edge: AnyObj, el: Element | null | undefined) {
    if (!el || !this.resizes || this.sizes.has(el)) return;
    this.sizes.set(el, edge);
    this.resizes.observe(el);
  }

  private handles(edge: AnyObj): Handle[] {
    return Array.isArray(edge[HANDLES]) ? edge[HANDLES] : [];
  }

  private removeHandles(edge: AnyObj) {
    for (const handle of this.handles(edge)) handle.wrapperEl.remove();
    delete edge[HANDLES];
  }

  // ---------- geometry ----------

  private pathEl(edge: AnyObj): SVGPathElement | null {
    const el = edge.path?.display;
    return el && typeof el.getTotalLength === "function" ? el : null;
  }

  /** The point `at` of the way along the line, and the direction across the line there (pointing to side 1). */
  private frame(edge: AnyObj, at: number): { point: Point; normal: Point } | null {
    try {
      const path = this.pathEl(edge);
      const total = path?.getTotalLength() ?? 0;
      if (path && total > 0) {
        const length = total * clamp01(at);
        const p = path.getPointAtLength(length);
        const a = path.getPointAtLength(Math.max(0, length - 0.5));
        const b = path.getPointAtLength(Math.min(total, length + 0.5));
        const size = Math.hypot(b.x - a.x, b.y - a.y);
        const normal = size > 0 ? { x: -(b.y - a.y) / size, y: (b.x - a.x) / size } : { x: 0, y: -1 };
        return { point: { x: p.x, y: p.y }, normal };
      }
    } catch {}
    try {
      const center = edge.getCenter?.();
      if (center) return { point: { x: center.x, y: center.y }, normal: { x: 0, y: -1 } };
    } catch {}
    return null;
  }

  /**
   * Where the middle of a label with this position sits, in canvas
   * coordinates. A label beside the line is pushed out just far enough for
   * its box (`sizeEl`) to clear the line.
   */
  private pointFor(edge: AnyObj, pos: LabelPos, sizeEl?: HTMLElement | null): Point | null {
    const frame = this.frame(edge, pos.at);
    if (!frame) return null;
    if (!pos.side) return frame.point;
    const { point, normal } = frame;
    const reach = Math.abs(normal.x) * (sizeEl?.offsetWidth ?? 0) / 2 + Math.abs(normal.y) * (sizeEl?.offsetHeight ?? 0) / 2 + SIDE_GAP;
    return { x: point.x + normal.x * reach * pos.side, y: point.y + normal.y * reach * pos.side };
  }

  /** The point on the line closest to `target`: how far along it is, and how far away. */
  private nearest(edge: AnyObj, target: Point): { at: number; distance: number; total: number } | null {
    try {
      const path = this.pathEl(edge);
      const total = path?.getTotalLength() ?? 0;
      if (!path || !(total > 0)) return null;

      const distanceAt = (length: number) => {
        const p = path.getPointAtLength(length);
        return Math.hypot(p.x - target.x, p.y - target.y);
      };
      const steps = Math.max(20, Math.min(400, Math.ceil(total / 4)));
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i <= steps; i++) {
        const d = distanceAt((total * i) / steps);
        if (d < bestDistance) { bestDistance = d; best = (total * i) / steps; }
      }
      // Look closer around the best sample.
      const span = total / steps;
      for (let i = -10; i <= 10; i++) {
        const length = Math.max(0, Math.min(total, best + (span * i) / 10));
        const d = distanceAt(length);
        if (d < bestDistance) { bestDistance = d; best = length; }
      }
      return { at: best / total, distance: bestDistance, total };
    } catch { return null; }
  }

  /**
   * The position for a label dragged so its middle is at `center`: the nearest
   * spot along the line (the middle, when close), on the line if the label is
   * near it and otherwise on whichever side it was dragged to.
   */
  private posAt(edge: AnyObj, center: Point): LabelPos | null {
    const near = this.nearest(edge, center);
    if (!near) return null;
    const snap = SNAP / (Number(edge.canvas?.scale) || 1);
    const at = Math.abs(near.at - 0.5) * near.total <= snap ? 0.5 : round(near.at, 4);
    if (near.distance <= snap) return { at };
    const frame = this.frame(edge, at);
    if (!frame) return { at };
    const across = (center.x - frame.point.x) * frame.normal.x + (center.y - frame.point.y) * frame.normal.y;
    return { at, side: across < 0 ? -1 : 1 };
  }

  // ---------- Obsidian's own label ----------

  /** Make the native label draggable, and keep it where it was put. */
  private wireNative(edge: AnyObj) {
    const label = edge.labelElement;
    const wrapperEl: HTMLElement | undefined = label?.wrapperEl;
    if (!label || !wrapperEl || label[WIRED] === this.abort) return;
    label[WIRED] = this.abort;
    this.watchSize(edge, wrapperEl.firstElementChild);

    const self = this;
    this.patchProto(Object.getPrototypeOf(label), "render", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try { if (this.edge) self.placeNative(this.edge); } catch {}
      return result;
    });

    this.wireDrag(edge, wrapperEl, {
      isEditing: () => !!label.isEditing,
      get: () => this.getPos(edge),
      set: pos => {
        this.setPos(edge, pos);
        // Back in the middle: let Obsidian place it.
        try { label.render?.(); } catch {}
      },
    });
  }

  private placeNative(edge: AnyObj) {
    const wrapperEl: HTMLElement | undefined = edge.labelElement?.wrapperEl;
    const pos = wrapperEl ? this.getPos(edge) : null;
    if (!wrapperEl || !pos) return;
    const point = this.pointFor(edge, pos, wrapperEl.firstElementChild as HTMLElement | null);
    if (point) wrapperEl.style.transform = `translate(${round(point.x)}px, ${round(point.y)}px)`;
  }

  // ---------- adding ----------

  /** Add a label where the line was clicked. False if the spot can't be worked out. */
  private addAt(edge: AnyObj, evt: MouseEvent): boolean {
    const canvas = edge.canvas;
    const pos = this.posAt(edge, canvas.posFromEvt(evt));
    if (!pos) return false;
    const onLine: LabelPos = { at: pos.at };

    if (!edge.label && !edge.labelElement && typeof edge.editLabel === "function") {
      // The line's first label is Obsidian's own, so other apps show it too.
      this.setPos(edge, onLine);
      edge.editLabel();
      return true;
    }

    this.setExtras(edge, [...this.getExtras(edge), { text: "", ...onLine }]);
    const handle = this.createHandle(edge);
    const handles = this.handles(edge);
    handles.push(handle);
    edge[HANDLES] = handles;
    this.edges.add(edge);
    this.copyColor(edge, handle.wrapperEl);
    this.layout(edge);
    this.startEditing(edge, handle);
    return true;
  }

  // ---------- extra labels ----------

  private createHandle(edge: AnyObj): Handle {
    const canvas = edge.canvas;
    const wrapperEl: HTMLElement = canvas.canvasEl.createDiv(`canvas-path-label-wrapper ${EXTRA_CLASS}`);
    const textEl: HTMLElement = wrapperEl.createDiv({
      cls: "canvas-path-label",
      attr: { contenteditable: "false", "data-placeholder": "Add text" },
    });
    const handle: Handle = { wrapperEl, textEl, editing: false, initialText: "" };
    this.watchSize(edge, textEl);
    const index = () => this.handles(edge).indexOf(handle);

    // Same as Obsidian's label: click selects the line, click again edits the text.
    wrapperEl.addEventListener("click", evt => {
      if (canvas.readonly) return;
      if (evt.shiftKey) {
        this.finishEditing(edge, handle);
        canvas.toggleSelect?.(edge);
        return;
      }
      const selection = canvas.selection;
      if (selection?.size === 1 && selection.has(edge)) {
        if (!handle.editing) this.startEditing(edge, handle, { x: evt.clientX, y: evt.clientY });
      } else {
        canvas.selectOnly?.(edge);
      }
    });

    textEl.addEventListener("input", () => {
      const list = this.getExtras(edge);
      const i = index();
      if (!list[i]) return;
      list[i] = { ...list[i], text: textEl.innerText };
      this.setExtras(edge, list);
      try { canvas.requestSave?.(false); } catch {}
    });
    textEl.addEventListener("keydown", evt => {
      if (evt.key !== "Escape" || !handle.editing) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.finishEditing(edge, handle);
    });
    textEl.addEventListener("blur", () => this.finishEditing(edge, handle));

    this.wireDrag(edge, wrapperEl, {
      isEditing: () => handle.editing,
      get: () => this.getExtras(edge)[index()] ?? null,
      set: pos => {
        const list = this.getExtras(edge);
        const i = index();
        if (!list[i] || !pos) return;
        list[i] = { text: list[i].text, ...pos };
        this.setExtras(edge, list);
        this.layout(edge);
      },
    });
    return handle;
  }

  private startEditing(edge: AnyObj, handle: Handle, point?: { x: number; y: number }) {
    for (const other of this.handles(edge).slice()) {
      if (other !== handle) this.finishEditing(edge, other);
    }
    try { if (edge.labelElement?.isEditing) edge.labelElement.blur(); } catch {}

    const { textEl } = handle;
    handle.editing = true;
    handle.initialText = textEl.innerText;
    textEl.setAttribute("contenteditable", "true");
    textEl.classList.add("is-editing");

    const doc = textEl.ownerDocument;
    let range: Range | null = point ? doc.caretRangeFromPoint(point.x, point.y) : null;
    if (!range) {
      range = doc.createRange();
      range.selectNodeContents(textEl);
    }
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    textEl.focus();
  }

  private finishEditing(edge: AnyObj, handle: Handle) {
    if (!handle.editing) return;
    handle.editing = false;
    const { textEl } = handle;
    textEl.setAttribute("contenteditable", "false");
    textEl.classList.remove("is-editing");
    if (textEl.ownerDocument.activeElement === textEl) textEl.blur();

    const text = textEl.innerText;
    const changed = text !== handle.initialText;
    handle.initialText = "";
    // An emptied label is removed.
    if (!text.trim()) this.removeExtra(edge, handle);
    if (changed) {
      try { edge.canvas.requestSave?.(); } catch {}
    }
  }

  private removeExtra(edge: AnyObj, handle: Handle) {
    const handles = this.handles(edge);
    const i = handles.indexOf(handle);
    if (i < 0) return;
    handles.splice(i, 1);
    handle.wrapperEl.remove();
    const list = this.getExtras(edge);
    list.splice(i, 1);
    this.setExtras(edge, list);
  }

  /** Give an extra label the line's color, the way Obsidian colors its own label. */
  private copyColor(edge: AnyObj, el: HTMLElement) {
    const source: Element | undefined = edge.lineGroupEl;
    for (const cls of Array.from(el.classList)) {
      if (cls.startsWith("mod-canvas-color")) el.classList.remove(cls);
    }
    el.style.removeProperty("--canvas-color");
    el.classList.toggle("is-themed", !!edge.color);
    if (!source || !edge.color) return;
    for (const cls of Array.from(source.classList)) {
      if (cls.startsWith("mod-canvas-color")) el.classList.add(cls);
    }
    const custom = (source as SVGElement).style?.getPropertyValue("--canvas-color");
    if (custom) el.style.setProperty("--canvas-color", custom);
  }

  // ---------- dragging ----------

  /** Drag a label along its line, or off it to one side. A press that doesn't move stays a click. */
  private wireDrag(
    edge: AnyObj,
    wrapperEl: HTMLElement,
    label: { isEditing: () => boolean; get: () => LabelPos | null; set: (pos: LabelPos | null) => void },
  ) {
    const { signal } = this.abort;
    let suppressClick = false;

    // The click that ends a drag shouldn't open the label for editing.
    wrapperEl.addEventListener("click", evt => {
      if (!suppressClick) return;
      suppressClick = false;
      evt.preventDefault();
      evt.stopImmediatePropagation();
    }, { capture: true, signal });

    wrapperEl.addEventListener("pointerdown", (down: PointerEvent) => {
      const canvas = edge.canvas;
      if (!down.isPrimary || down.button !== 0 || !canvas || canvas.readonly || label.isEditing()) return;
      // Keep the canvas from panning or box-selecting.
      down.stopPropagation();
      suppressClick = false;

      const doc = wrapperEl.ownerDocument;
      const start = this.pointFor(edge, label.get() ?? { at: 0.5 }, wrapperEl.firstElementChild as HTMLElement | null);
      const pointer: Point = canvas.posFromEvt(down);
      if (!start || !pointer) return;
      const grab = { x: start.x - pointer.x, y: start.y - pointer.y };
      const before = JSON.stringify(label.get());
      let dragging = false;

      const move = (evt: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(evt.clientX - down.clientX, evt.clientY - down.clientY) < DRAG_THRESHOLD) return;
          dragging = true;
          wrapperEl.classList.add("is-dragging");
          try { if (!canvas.selection?.has(edge)) canvas.selectOnly?.(edge); } catch {}
        }
        evt.preventDefault();
        const at: Point = canvas.posFromEvt(evt);
        const pos = this.posAt(edge, { x: at.x + grab.x, y: at.y + grab.y });
        if (pos) label.set(pos);
      };
      const end = () => {
        doc.removeEventListener("pointermove", move, true);
        doc.removeEventListener("pointerup", end, true);
        doc.removeEventListener("pointercancel", end, true);
        if (!dragging) return;
        wrapperEl.classList.remove("is-dragging");
        suppressClick = true;
        doc.defaultView?.setTimeout(() => { suppressClick = false; }, 0);
        if (JSON.stringify(label.get()) !== before) {
          try { canvas.requestSave?.(); } catch {}
        }
      };
      doc.addEventListener("pointermove", move, true);
      doc.addEventListener("pointerup", end, true);
      doc.addEventListener("pointercancel", end, true);
    }, { signal });
  }
}

function cleanPos(value: unknown): LabelPos | null {
  const v = value as AnyObj;
  if (!v || typeof v !== "object" || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  const pos: LabelPos = { at: clamp01(v.at) };
  if (v.side === 1 || v.side === -1) pos.side = v.side;
  return pos;
}

/** On the line at its middle: where Obsidian puts a label anyway. */
function isMiddle(pos: LabelPos): boolean {
  return pos.at === 0.5 && !pos.side;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number, places = 2): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
