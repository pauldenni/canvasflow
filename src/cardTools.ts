import { Menu, Notice, Plugin, setIcon, setTooltip } from "obsidian";

/**
 * Extra tools in the Obsidian Canvas card action bar:
 *
 * - Text formatting (text cards): align, bold, italic. Stored on the node
 *   under `canvasflowText`.
 * - Lock (any card): a locked card can't be moved, resized or deleted, but
 *   its text stays editable. Stored on the node as `canvasflowLocked: true`.
 *
 * Both live in the .canvas JSON (the canvas spec allows extra keys on nodes),
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
const NOTICE_THROTTLE_MS = 1500;

type AnyObj = any;

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

  constructor(private plugin: Plugin, private formattingEnabled: () => boolean) {}

  load() {
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

  private getStyle(node: AnyObj): CardTextStyle {
    return { ...(this.getData(node)?.[TEXT_KEY] ?? {}) };
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
    if (style.align && style.align !== "left") clean.align = style.align;
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

    const style = this.isTextNode(node) ? this.getStyle(node) : {};
    const toggle = (attr: string, value: string | null) => {
      if (value === null) el.removeAttribute(attr);
      else el.setAttribute(attr, value);
    };

    toggle("data-canvasflow-align", style.align && style.align !== "left" ? style.align : null);
    toggle("data-canvasflow-bold", style.bold ? "true" : null);
    toggle("data-canvasflow-italic", style.italic ? "true" : null);
    toggle("data-canvasflow-locked", this.isLocked(node) ? "true" : null);
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

    if (!cards.length) return;

    // Insert before the native "Edit" button so the bar reads
    // delete · color · zoom · [lock · align · bold · italic] · edit.
    const editButton = menuEl.querySelector<HTMLElement>('[aria-label="Edit"], .canvas-menu-edit');
    const insert = (btn: HTMLElement) => {
      if (editButton && editButton.parentElement === menuEl) menuEl.insertBefore(btn, editButton);
      else menuEl.appendChild(btn);
    };

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
