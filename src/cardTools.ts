import { Menu, Notice, Plugin, setIcon, setTooltip } from "obsidian";
import { SHAPES, SHAPES_BY_ID, SHAPE_KEY, SHAPE_STROKE, ShapeDef, buildShapeIcon, buildShapeSvg, drawShape } from "./shapeGeometry";
import { LineStyle, LineTools, showStrokeMenu } from "./lineTools";

/**
 * Extra tools in the Obsidian Canvas card action bar:
 *
 * - Text formatting (text cards): align, bold, italic. Stored on the node
 *   under `canvasflowText`.
 * - Lock (any card): a locked card can't be moved, resized or deleted, but
 *   its text stays editable. Stored on the node as `canvasflowLocked: true`.
 * - Shapes (text cards): a "Shapes" button next to the canvas's own add-card
 *   buttons adds a text card drawn as a shape; the action bar can change a
 *   text card's shape. Stored on the node as `canvasflowShape: "<id>"`.
 *
 * - Shape outlines: style and thickness, from the action bar. Stored on the
 *   node as `canvasflowShapeLine: { style?, width? }`.
 * - Lines: style, thickness and curved/straight/elbow paths (see lineTools.ts).
 *
 * All of these live in the .canvas JSON (the canvas spec allows extra keys on nodes),
 * so they survive reloads, copy/paste and undo/redo. They're rendered by
 * mirroring them onto the node element as data attributes that styles.css
 * targets.
 *
 * Obsidian's canvas internals are not public API, so every hook here is
 * defensive: if an internal is missing, that part quietly does nothing.
 */

export type TextAlign = "left" | "center" | "right";

export interface CardTextStyle {
  align?: TextAlign;
  bold?: boolean;
  italic?: boolean;
}

const TEXT_KEY = "canvasflowText";
const LOCK_KEY = "canvasflowLocked";
const BUTTON_CLASS = "canvasflow-format-button";
const SELECTION_LOCKED_CLASS = "canvasflow-selection-locked";
const SHAPE_LINE_KEY = "canvasflowShapeLine";
const SHAPE_SVG_CLASS = "canvasflow-shape";
const SHAPE_ADD_BUTTON_CLASS = "canvasflow-shape-add";
const PICKER_CLASS = "canvasflow-shape-picker";
/** Per-node caches, stored on the node object. */
const NODE_SHAPE = "__canvasflowShape";
const NODE_SHAPE_KEY = "__canvasflowShapeKey";
const NOTICE_THROTTLE_MS = 1500;

type AnyObj = any;

/** A shape's outline; the default is a solid 1px line, like a card border. */
export interface ShapeOutline {
  style?: Exclude<LineStyle, "solid">;
  width?: number;
}

export class CardTools {
  private patched = new WeakMap<object, Set<string>>();
  private patchedCanvases = new WeakSet<object>();
  /**
   * Above zero while Obsidian itself is rebuilding the canvas (undo/redo,
   * paste, closing the file, converting a card to a file). Locks only stop
   * you, not those.
   */
  private systemChange = 0;
  private lastNoticeAt = 0;
  private closePicker: (() => void) | null = null;
  private lines: LineTools;

  constructor(private plugin: Plugin, private formattingEnabled: () => boolean) {
    this.lines = new LineTools(
      (proto, method, wrap) => this.patchProto(proto, method, wrap),
      cb => this.plugin.register(cb),
    );
  }

  load() {
    this.plugin.register(() => this.closePicker?.());
    const { workspace } = this.plugin.app;
    const sweep = () => this.attachToOpenCanvases();
    workspace.onLayoutReady(sweep);
    this.plugin.registerEvent(workspace.on("layout-change", sweep));
    this.plugin.registerEvent(workspace.on("active-leaf-change", sweep));
    this.plugin.registerEvent(workspace.on("file-open", sweep));
  }

  /** Re-render every open canvas, e.g. after a setting is toggled. */
  refreshAll() {
    for (const canvas of this.getOpenCanvases()) {
      this.applyAll(canvas);
      try { canvas.menu?.render?.(); } catch {}
    }
  }

  private getOpenCanvases(): AnyObj[] {
    return this.plugin.app.workspace
      .getLeavesOfType("canvas")
      .map(leaf => (leaf.view as AnyObj)?.canvas)
      .filter(Boolean);
  }

  private attachToOpenCanvases() {
    for (const canvas of this.getOpenCanvases()) {
      if (!this.patchedCanvases.has(canvas)) {
        this.patchedCanvases.add(canvas);
        this.patchCanvas(canvas);
      }
      this.applyAll(canvas);
    }
  }

  private patchCanvas(canvas: AnyObj) {
    const self = this;
    const proto = Object.getPrototypeOf(canvas);

    // New nodes (created, pasted, duplicated, restored by undo).
    this.patchProto(proto, "addNode", orig => function (this: AnyObj, node: AnyObj, ...rest: any[]) {
      const result = orig.call(this, node, ...rest);
      self.watchNode(node);
      return result;
    });

    // Obsidian rebuilding the canvas may move or remove locked cards.
    for (const method of ["importData", "clear"]) {
      this.patchProto(proto, method, orig => function (this: AnyObj, ...args: any[]) {
        return self.asSystemChange(() => orig.apply(this, args));
      });
    }

    // Deleting: Delete/Backspace, the trash button, Cut and "Remove" all end here.
    this.patchProto(proto, "removeNode", orig => function (this: AnyObj, node: AnyObj, ...rest: any[]) {
      if (self.systemChange === 0 && self.isLocked(node)) {
        self.notice("Locked cards can't be deleted. Unlock them first.");
        return;
      }
      return orig.call(this, node, ...rest);
    });

    // Grabbing a locked card doesn't start a drag (it still gets selected).
    // Locked cards in a selection dragged by another card stay put (see moveAndResize).
    this.patchProto(proto, "handleSelectionDrag", orig => function (this: AnyObj, evt: AnyObj, el: AnyObj, node: AnyObj, ...rest: any[]) {
      if (node && self.isLocked(node)) {
        if (!this.selection?.has?.(node)) this.selectOnly?.(node);
        return;
      }
      return orig.call(this, evt, el, node, ...rest);
    });

    // The floating action bar shown above the selection.
    const menu = canvas.menu;
    if (menu) {
      this.patchProto(Object.getPrototypeOf(menu), "render", orig => function (this: AnyObj, ...args: any[]) {
        const result = orig.apply(this, args);
        try { self.renderButtons(this); } catch (err) { console.error("[CanvasFlow] card buttons", err); }
        return result;
      });
      try { menu.render?.(); } catch {}
    }

    this.addShapeButton(canvas);
    this.lines.patchCanvas(canvas);
  }

  /** Patch the node's class once (per card type) and apply its current styling. */
  private watchNode(node: AnyObj) {
    if (!node) return;
    const proto = Object.getPrototypeOf(node);
    const self = this;

    // Data changes (undo, redo, edits) re-apply styling.
    this.patchProto(proto, "setData", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      self.applyStyle(this);
      return result;
    });

    // Every move and resize (dragging, arrow keys, resize handles, auto-fit) goes through here.
    this.patchProto(proto, "moveAndResize", orig => function (this: AnyObj, ...args: any[]) {
      if (self.systemChange === 0 && self.isLocked(this)) return;
      return orig.apply(this, args);
    });

    // Shapes are drawn for the card's size, so redraw when it changes.
    this.patchProto(proto, "render", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      if (this[NODE_SHAPE] || this[NODE_SHAPE_KEY]) {
        try { self.renderShape(this); } catch (err) { console.error("[CanvasFlow] shape", err); }
      }
      return result;
    });

    // Editing opens the text in an iframe; carry the card's formatting into it.
    this.patchProto(proto, "startEditing", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      try { self.syncEditorSoon(this); } catch {}
      return result;
    });

    // "Convert to file" replaces the card with a new file card; let it remove the old one.
    this.patchProto(proto, "convertToFile", orig => function (this: AnyObj, ...args: any[]) {
      return self.asSystemChange(() => orig.apply(this, args));
    });

    this.applyStyle(node);
  }

  /** Run Obsidian's own change with locks relaxed, including async ones. */
  private asSystemChange<T>(run: () => T): T {
    this.systemChange++;
    let result: T;
    try {
      result = run();
    } catch (err) {
      this.systemChange--;
      throw err;
    }
    if (result && typeof (result as AnyObj).then === "function") {
      (result as AnyObj).then(
        () => { this.systemChange--; },
        () => { this.systemChange--; },
      );
    } else {
      this.systemChange--;
    }
    return result;
  }

  private applyAll(canvas: AnyObj) {
    const nodes: AnyObj[] = canvas.nodes instanceof Map ? Array.from(canvas.nodes.values()) : [];
    for (const node of nodes) this.watchNode(node);
    this.lines.applyAll(canvas);
  }

  /** Wrap a method on a shared prototype once; restored when the plugin unloads. */
  private patchProto(proto: AnyObj, method: string, wrap: (orig: (...a: any[]) => any) => (...a: any[]) => any) {
    if (!proto || typeof proto[method] !== "function") return;
    let done = this.patched.get(proto);
    if (!done) this.patched.set(proto, (done = new Set()));
    if (done.has(method)) return;

    const orig = proto[method];
    proto[method] = wrap(orig);
    done.add(method);

    this.plugin.register(() => {
      proto[method] = orig;
      done?.delete(method);
    });
  }

  private notice(message: string) {
    const now = Date.now();
    if (now - this.lastNoticeAt < NOTICE_THROTTLE_MS) return;
    this.lastNoticeAt = now;
    new Notice(message);
  }

  // ---------- data ----------

  private getData(node: AnyObj): AnyObj | null {
    try { return node?.getData?.() ?? null; } catch { return null; }
  }

  private isCard(item: AnyObj): boolean {
    return !!item?.nodeEl && !!this.getData(item)?.type;
  }

  private isTextNode(node: AnyObj): boolean {
    return this.getData(node)?.type === "text";
  }

  private isLocked(node: AnyObj): boolean {
    return this.getData(node)?.[LOCK_KEY] === true;
  }

  /** Shapes are centered unless you choose otherwise; standard cards are left-aligned. */
  private defaultAlign(node: AnyObj): TextAlign {
    return this.getShape(node) ? "center" : "left";
  }

  /** The card's text style, with its alignment always filled in. */
  private getStyle(node: AnyObj): CardTextStyle {
    const stored: CardTextStyle = { ...(this.getData(node)?.[TEXT_KEY] ?? {}) };
    return { ...stored, align: stored.align ?? this.defaultAlign(node) };
  }

  /** Write extra keys onto a node's data; `undefined` removes a key. */
  private updateData(node: AnyObj, changes: Record<string, unknown>) {
    const next = { ...node.getData() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    this.asSystemChange(() => node.setData(next));
    this.applyStyle(node);
  }

  private setStyle(node: AnyObj, style: CardTextStyle) {
    const clean: CardTextStyle = {};
    if (style.align && style.align !== this.defaultAlign(node)) clean.align = style.align;
    if (style.bold) clean.bold = true;
    if (style.italic) clean.italic = true;
    this.updateData(node, { [TEXT_KEY]: Object.keys(clean).length ? clean : undefined });
  }

  private setLocked(node: AnyObj, locked: boolean) {
    this.updateData(node, { [LOCK_KEY]: locked ? true : undefined });
  }

  private applyStyle(node: AnyObj) {
    const el: HTMLElement | undefined = node?.nodeEl;
    if (!el) return;

    const shape = this.getShape(node);
    const style = this.isTextNode(node) ? this.getStyle(node) : {};
    const attrs = this.styleAttributes(shape, style);
    attrs["data-canvasflow-locked"] = this.isLocked(node) ? "true" : null;
    this.setAttributes(el, attrs);

    const outline = shape ? this.getOutline(node) : {};
    this.setAttributes(el, { "data-canvasflow-outline-style": outline.style ?? null });
    if (outline.width) el.style.setProperty("--canvasflow-outline-width", `${outline.width}px`);
    else el.style.removeProperty("--canvasflow-outline-width");

    node[NODE_SHAPE] = shape?.id;
    this.renderShape(node);
    this.syncEditor(node);
  }

  /** Attributes styles.css uses for a card's text, on the card and inside its editor. */
  private styleAttributes(shape: ShapeDef | undefined, style: CardTextStyle): Record<string, string | null> {
    return {
      "data-canvasflow-shape": shape ? shape.id : null,
      "data-canvasflow-align": style.align && style.align !== "left" ? style.align : null,
      "data-canvasflow-bold": style.bold ? "true" : null,
      "data-canvasflow-italic": style.italic ? "true" : null,
    };
  }

  private setAttributes(el: Element, attrs: Record<string, string | null>) {
    for (const [attr, value] of Object.entries(attrs)) {
      if (value === null) el.removeAttribute(attr);
      else if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
    }
  }

  /**
   * Canvas text cards are edited in an iframe, so styles keyed to the card
   * element never reach the editor. Mirror the card's shape and formatting
   * onto the iframe's <body>, which Obsidian leaves alone (it only syncs the
   * body's classes and the stylesheets, including this plugin's).
   */
  private syncEditor(node: AnyObj): boolean {
    if (!this.isTextNode(node)) return false;
    const editMode = node.child?.editMode;
    if (editMode) this.watchEditor(editMode);

    const iframe: HTMLIFrameElement | null =
      editMode?.iframeEl ?? node.contentEl?.querySelector?.("iframe.embed-iframe") ?? null;
    const body = iframe?.contentDocument?.body;
    if (!body) return false;

    this.setAttributes(body, this.styleAttributes(this.getShape(node), this.getStyle(node)));
    return true;
  }

  /** Re-sync when Obsidian reloads a card's editor iframe (it does when the card is re-attached). */
  private watchEditor(editMode: AnyObj) {
    const self = this;
    this.patchProto(Object.getPrototypeOf(editMode), "onIframeLoad", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      const node = this.owner?.node;
      if (node) {
        try { self.syncEditor(node); } catch {}
      }
      return result;
    });
  }

  /** After editing starts, keep syncing until the editor iframe is ready. */
  private syncEditorSoon(node: AnyObj) {
    if (!this.isTextNode(node)) return;
    const win = node?.nodeEl?.win ?? window;
    let frames = 0;
    const tick = () => {
      const ready = this.syncEditor(node) && !!node.child?.editMode?.iframeEl?.contentDocument?.querySelector?.(".cm-editor");
      if (!ready && ++frames < 30) win.requestAnimationFrame(tick);
    };
    tick();
  }

  private getShape(node: AnyObj): ShapeDef | undefined {
    if (!this.isTextNode(node)) return undefined;
    const id = this.getData(node)?.[SHAPE_KEY];
    return typeof id === "string" ? SHAPES_BY_ID.get(id) : undefined;
  }

  /** Draw (or remove) the shape outline behind a card's text. */
  private renderShape(node: AnyObj) {
    const el: HTMLElement | undefined = node?.nodeEl;
    const container: HTMLElement | undefined = node?.containerEl;
    if (!el) return;

    const existing = container?.querySelector<SVGSVGElement>(`:scope > svg.${SHAPE_SVG_CLASS}`) ?? null;
    const shape: ShapeDef | undefined = node[NODE_SHAPE] ? SHAPES_BY_ID.get(node[NODE_SHAPE]) : undefined;

    if (!shape) {
      existing?.remove();
      node[NODE_SHAPE_KEY] = undefined;
      for (const side of ["top", "right", "bottom", "left"]) el.style.removeProperty(`--canvasflow-inset-${side}`);
      return;
    }
    // The container is created on the card's first render; the render patch catches that.
    if (!container) return;

    const width = Math.max(1, Number(node.width) || 0);
    const height = Math.max(1, Number(node.height) || 0);
    // Thicker outlines sit further in, so the whole stroke stays inside the card.
    const stroke = this.getOutline(node).width ?? SHAPE_STROKE;
    const key = `${shape.id}:${width}x${height}:${stroke}`;
    if (existing && node[NODE_SHAPE_KEY] === key) return;

    const svg = buildShapeSvg(shape, width, height, SHAPE_SVG_CLASS, stroke / 2, 1, stroke);
    if (existing) existing.replaceWith(svg);
    else container.prepend(svg);
    node[NODE_SHAPE_KEY] = key;

    const [top, right, bottom, left] = drawShape(shape, width, height, stroke / 2, 1, stroke).insets;
    el.style.setProperty("--canvasflow-inset-top", `${Math.round(top)}px`);
    el.style.setProperty("--canvasflow-inset-right", `${Math.round(right)}px`);
    el.style.setProperty("--canvasflow-inset-bottom", `${Math.round(bottom)}px`);
    el.style.setProperty("--canvasflow-inset-left", `${Math.round(left)}px`);
  }

  private getSelectedCards(canvas: AnyObj): AnyObj[] {
    const selection: Iterable<AnyObj> = canvas?.selection ?? [];
    return Array.from(selection).filter(item => this.isCard(item));
  }

  /** Apply a change to selected cards as a single undo step. */
  private commit(canvas: AnyObj, nodes: AnyObj[], change: (node: AnyObj) => void) {
    if (!nodes.length) return;
    for (const node of nodes) change(node);

    try { canvas.pushHistory?.(canvas.getData()); } catch {}
    try { canvas.requestSave?.(); } catch {}
    try { canvas.menu?.render?.(); } catch {}
  }

  // ---------- action bar ----------

  private renderButtons(menu: AnyObj) {
    const canvas = menu.canvas ?? this.getOpenCanvases().find(c => c.menu === menu);
    const menuEl: HTMLElement | null = menu.menuEl ?? canvas?.wrapperEl?.querySelector?.(".canvas-menu") ?? null;
    if (!canvas || !menuEl) return;

    menuEl.querySelectorAll(`.${BUTTON_CLASS}`).forEach(el => el.remove());

    const cards = this.getSelectedCards(canvas);
    const allLocked = cards.length > 0 && cards.every(n => this.isLocked(n));

    // Hide the selection's resize handles when everything selected is locked.
    canvas.wrapperEl?.classList?.toggle(SELECTION_LOCKED_CLASS, allLocked);

    // Insert before the native "Edit" button so the bar reads
    // delete · color · zoom · [lock · align · bold · italic] · edit.
    const editButton = menuEl.querySelector<HTMLElement>('[aria-label="Edit"], .canvas-menu-edit');
    const insert = (btn: HTMLElement) => {
      if (editButton && editButton.parentElement === menuEl) menuEl.insertBefore(btn, editButton);
      else menuEl.appendChild(btn);
    };

    this.lines.renderButtons(canvas, insert, (icon, label, active) => this.makeButton(icon, label, active));

    if (!cards.length) return;

    const many = cards.length > 1;
    const lockLabel = allLocked ? (many ? "Unlock cards" : "Unlock card") : (many ? "Lock cards" : "Lock card");
    const lockButton = this.makeButton(allLocked ? "lock" : "lock-open", lockLabel, allLocked);
    lockButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.commit(canvas, cards, node => this.setLocked(node, !allLocked));
    });
    insert(lockButton);

    if (!this.formattingEnabled()) return;

    const textNodes = cards.filter(n => this.isTextNode(n));
    if (!textNodes.length) return;

    const styles = textNodes.map(n => this.getStyle(n));
    const align: TextAlign = styles[0].align ?? "left";
    const allBold = styles.every(s => s.bold);
    const allItalic = styles.every(s => s.italic);
    const updateText = (change: (style: CardTextStyle) => CardTextStyle) =>
      this.commit(canvas, textNodes, node => this.setStyle(node, change(this.getStyle(node))));

    const alignButton = this.makeButton(`align-${align}`, "Align text");
    alignButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      const picker = new Menu();
      const options: Array<[TextAlign, string]> = [["left", "Align left"], ["center", "Align center"], ["right", "Align right"]];
      for (const [value, label] of options) {
        picker.addItem(item => item
          .setTitle(label)
          .setIcon(`align-${value}`)
          .setChecked(styles.every(s => (s.align ?? "left") === value))
          .onClick(() => updateText(s => ({ ...s, align: value }))));
      }
      const rect = alignButton.getBoundingClientRect();
      picker.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    });
    insert(alignButton);

    const boldButton = this.makeButton("bold", "Bold", allBold);
    boldButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      updateText(s => ({ ...s, bold: !allBold }));
    });
    insert(boldButton);

    const italicButton = this.makeButton("italic", "Italic", allItalic);
    italicButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      updateText(s => ({ ...s, italic: !allItalic }));
    });
    insert(italicButton);

    const shapes = textNodes.map(n => this.getShape(n)?.id ?? null);
    const current = shapes.every(id => id === shapes[0]) ? shapes[0] : undefined;
    const shapeButton = this.makeButton("shapes", many ? "Change shapes" : "Change shape", current != null);
    shapeButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.openShapePicker(shapeButton, "below", {
        current,
        includeCard: true,
        onPick: id => this.commit(canvas, textNodes, node => this.setShape(node, id)),
      });
    });
    insert(shapeButton);

    const shapeNodes = textNodes.filter(n => this.getShape(n));
    if (!shapeNodes.length) return;
    const outlines = shapeNodes.map(n => this.getOutline(n));
    const customized = outlines.some(o => o.style || o.width);
    const outlineButton = this.makeButton("pencil-line", shapeNodes.length > 1 ? "Outline styles" : "Outline style", customized);
    outlineButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      showStrokeMenu(outlineButton, outlines.map(o => ({ style: o.style ?? "solid", width: o.width ?? SHAPE_STROKE })), choice =>
        this.commit(canvas, shapeNodes, node => {
          const outline = this.getOutline(node);
          if (choice.style) outline.style = choice.style === "solid" ? undefined : choice.style;
          if (choice.width) outline.width = choice.width;
          this.setOutline(node, outline);
        }));
    });
    insert(outlineButton);
  }

  // ---------- shapes ----------

  private getOutline(node: AnyObj): ShapeOutline {
    const stored = this.getData(node)?.[SHAPE_LINE_KEY];
    return stored && typeof stored === "object" ? { ...stored } : {};
  }

  private setOutline(node: AnyObj, outline: ShapeOutline) {
    const clean: ShapeOutline = {};
    if (outline.style) clean.style = outline.style;
    if (outline.width && outline.width !== SHAPE_STROKE) clean.width = outline.width;
    this.updateData(node, { [SHAPE_LINE_KEY]: Object.keys(clean).length ? clean : undefined });
  }

  private setShape(node: AnyObj, id: string | null) {
    this.updateData(node, { [SHAPE_KEY]: id ?? undefined });
  }

  /** The "Shapes" button in the bar at the bottom of the canvas. */
  private addShapeButton(canvas: AnyObj) {
    const bar: HTMLElement | undefined = canvas.cardMenuEl ?? canvas.wrapperEl?.querySelector?.(".canvas-card-menu");
    if (!bar || bar.querySelector(`.${SHAPE_ADD_BUTTON_CLASS}`)) return;

    const button = document.createElement("div");
    button.className = `canvas-card-menu-button ${SHAPE_ADD_BUTTON_CLASS}`;
    button.setAttribute("aria-label", "Add shape");
    setIcon(button, "shapes");
    setTooltip(button, "Add shape", { placement: "top" });
    button.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      if (button.hasClass("is-active")) {
        this.closePicker?.();
        return;
      }
      button.addClass("is-active");
      this.openShapePicker(button, "above", {
        includeCard: false,
        onPick: id => {
          const shape = id ? SHAPES_BY_ID.get(id) : undefined;
          if (shape) this.createShape(canvas, shape);
        },
        onDrag: (evt, shape) => this.dragShape(canvas, evt, shape),
        onClose: () => button.removeClass("is-active"),
      });
    });
    bar.appendChild(button);
    this.plugin.register(() => button.remove());
  }

  /** Add a shape card, at the viewport center or at a dropped position (top-left). */
  private createShape(canvas: AnyObj, shape: ShapeDef, topLeft?: { x: number; y: number }) {
    if (canvas.readonly || typeof canvas.createTextNode !== "function") return;
    const node = canvas.createTextNode({
      pos: topLeft ?? canvas.posCenter(),
      position: topLeft ? undefined : "center",
      size: { ...shape.size },
      save: false,
      focus: false,
    });
    if (!node) return;
    this.watchNode(node);
    this.updateData(node, { [SHAPE_KEY]: shape.id });
    try { canvas.requestSave?.(); } catch {}

    // Same as a new standard card: select it and start typing the label.
    try {
      node.attach?.();
      node.render?.();
      canvas.selectOnly?.(node);
      node.startEditing?.();
    } catch {}
  }

  /** Drag a shape out of the picker onto the canvas, like the native add-card button. */
  private dragShape(canvas: AnyObj, evt: PointerEvent, shape: ShapeDef) {
    if (canvas.readonly || typeof canvas.dragTempNode !== "function") return;
    canvas.dragTempNode(evt, { ...shape.size }, (pos: { x: number; y: number }) => {
      this.closePicker?.();
      try { canvas.deselectAll?.(); } catch {}
      this.createShape(canvas, shape, pos);
    });
  }

  private openShapePicker(
    anchor: HTMLElement,
    placement: "above" | "below",
    options: {
      current?: string | null;
      includeCard: boolean;
      onPick: (id: string | null) => void;
      onDrag?: (evt: PointerEvent, shape: ShapeDef) => void;
      onClose?: () => void;
    },
  ) {
    this.closePicker?.();

    const doc = anchor.ownerDocument;
    const win = doc.defaultView ?? window;
    const picker = doc.body.createDiv(PICKER_CLASS);
    const grid = picker.createDiv(`${PICKER_CLASS}-grid`);

    const close = () => {
      if (this.closePicker !== close) return;
      this.closePicker = null;
      picker.remove();
      doc.removeEventListener("pointerdown", onOutside, true);
      doc.removeEventListener("keydown", onKey, true);
      win.removeEventListener("resize", close);
      options.onClose?.();
    };
    const onOutside = (evt: PointerEvent) => {
      const target = evt.target as Node | null;
      if (target && (picker.contains(target) || anchor.contains(target))) return;
      close();
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key !== "Escape") return;
      evt.preventDefault();
      evt.stopPropagation();
      close();
    };

    for (const shape of SHAPES) {
      const item = grid.createEl("button", { cls: `clickable-icon ${PICKER_CLASS}-item` });
      item.type = "button";
      item.setAttribute("aria-label", shape.label);
      setTooltip(item, shape.label, { placement: placement === "above" ? "top" : "bottom" });
      item.appendChild(buildShapeIcon(shape));
      if (options.current === shape.id) item.addClass("is-active");
      item.addEventListener("click", evt => {
        evt.preventDefault();
        evt.stopPropagation();
        close();
        options.onPick(shape.id);
      });
      if (options.onDrag) {
        const onDrag = options.onDrag;
        item.addEventListener("pointerdown", evt => onDrag(evt, shape));
      }
    }

    if (options.includeCard) {
      const card = picker.createEl("button", { cls: `${PICKER_CLASS}-card`, text: "Standard card" });
      card.type = "button";
      if (options.current === null) card.addClass("is-active");
      card.addEventListener("click", evt => {
        evt.preventDefault();
        evt.stopPropagation();
        close();
        options.onPick(null);
      });
    }

    // Position next to the anchor, kept on screen.
    const rect = anchor.getBoundingClientRect();
    const box = picker.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - box.width / 2), win.innerWidth - box.width - margin);
    const top = placement === "above" ? rect.top - box.height - margin : rect.bottom + margin;
    picker.style.left = `${Math.round(left)}px`;
    picker.style.top = `${Math.round(Math.max(margin, top))}px`;

    doc.addEventListener("pointerdown", onOutside, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("resize", close);
    this.closePicker = close;
  }

  private makeButton(icon: string, label: string, active = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `clickable-icon ${BUTTON_CLASS}`;
    btn.setAttribute("aria-label", label);
    if (active) btn.classList.add("is-active");
    setIcon(btn, icon);
    setTooltip(btn, label, { placement: "top" });
    return btn;
  }
}
