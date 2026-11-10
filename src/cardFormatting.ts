import { Menu, Plugin, setIcon, setTooltip } from "obsidian";

/**
 * Card text formatting for Obsidian Canvas text cards.
 *
 * Formatting is stored on each text node in the .canvas JSON under
 * `canvasflowText` (the canvas spec allows extra keys on nodes), and is
 * rendered by mirroring it onto the node element as data attributes that
 * styles.css targets. Because it lives in the file, it survives reloads,
 * copy/paste and undo/redo.
 *
 * Obsidian's canvas internals are not public API, so every hook here is
 * defensive: if an internal is missing, the feature quietly does nothing.
 */

export type TextAlign = "left" | "center" | "right";

export interface CardTextStyle {
  align?: TextAlign;
  bold?: boolean;
  italic?: boolean;
}

const DATA_KEY = "canvasflowText";
const BUTTON_CLASS = "canvasflow-format-button";

type AnyObj = any;

export class CardFormatting {
  private patched = new WeakMap<object, Set<string>>();
  private patchedCanvases = new WeakSet<object>();

  constructor(private plugin: Plugin, private isEnabled: () => boolean) {}

  load() {
    const { workspace } = this.plugin.app;
    const sweep = () => this.attachToOpenCanvases();
    workspace.onLayoutReady(sweep);
    this.plugin.registerEvent(workspace.on("layout-change", sweep));
    this.plugin.registerEvent(workspace.on("active-leaf-change", sweep));
    this.plugin.registerEvent(workspace.on("file-open", sweep));
  }

  /** Re-render every open canvas, e.g. after the setting is toggled. */
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

    // New nodes (created, pasted, duplicated, restored by undo).
    this.patchProto(Object.getPrototypeOf(canvas), "addNode", orig => function (this: AnyObj, node: AnyObj, ...rest: any[]) {
      const result = orig.call(this, node, ...rest);
      self.watchNode(node);
      return result;
    });

    // The floating action bar shown above the selection.
    const menu = canvas.menu;
    if (menu) {
      this.patchProto(Object.getPrototypeOf(menu), "render", orig => function (this: AnyObj, ...args: any[]) {
        const result = orig.apply(this, args);
        try { self.renderButtons(this); } catch (err) { console.error("[CanvasFlow] format buttons", err); }
        return result;
      });
      try { menu.render?.(); } catch {}
    }
  }

  /** Patch the node's class once so data changes (undo, redo, edits) re-apply styling. */
  private watchNode(node: AnyObj) {
    if (!node) return;
    const proto = Object.getPrototypeOf(node);
    const self = this;
    this.patchProto(proto, "setData", orig => function (this: AnyObj, ...args: any[]) {
      const result = orig.apply(this, args);
      self.applyStyle(this);
      return result;
    });
    this.applyStyle(node);
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

  // ---------- data ----------

  private isTextNode(node: AnyObj): boolean {
    try { return node?.getData?.()?.type === "text"; } catch { return false; }
  }

  private getStyle(node: AnyObj): CardTextStyle {
    try { return { ...(node.getData()?.[DATA_KEY] ?? {}) }; } catch { return {}; }
  }

  private setStyle(node: AnyObj, style: CardTextStyle) {
    const data = node.getData();
    const clean: CardTextStyle = {};
    if (style.align && style.align !== "left") clean.align = style.align;
    if (style.bold) clean.bold = true;
    if (style.italic) clean.italic = true;

    const next = { ...data };
    if (Object.keys(clean).length) next[DATA_KEY] = clean;
    else delete next[DATA_KEY];

    node.setData(next);
    this.applyStyle(node);
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
  }

  private getSelectedTextNodes(canvas: AnyObj): AnyObj[] {
    const selection: Iterable<AnyObj> = canvas?.selection ?? [];
    return Array.from(selection).filter(n => this.isTextNode(n));
  }

  /** Apply a change to every selected text card as a single undo step. */
  private updateSelection(canvas: AnyObj, change: (style: CardTextStyle) => CardTextStyle) {
    const nodes = this.getSelectedTextNodes(canvas);
    if (!nodes.length) return;

    for (const node of nodes) this.setStyle(node, change(this.getStyle(node)));

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
    if (!this.isEnabled()) return;

    const nodes = this.getSelectedTextNodes(canvas);
    if (!nodes.length) return;

    const styles = nodes.map(n => this.getStyle(n));
    const align: TextAlign = styles[0].align ?? "left";
    const allBold = styles.every(s => s.bold);
    const allItalic = styles.every(s => s.italic);

    // Insert before the native "Edit" button so the bar reads
    // delete · color · zoom · [align · bold · italic] · edit.
    const editButton = menuEl.querySelector<HTMLElement>('[aria-label="Edit"], .canvas-menu-edit');
    const insert = (btn: HTMLElement) => {
      if (editButton && editButton.parentElement === menuEl) menuEl.insertBefore(btn, editButton);
      else menuEl.appendChild(btn);
    };

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
          .onClick(() => this.updateSelection(canvas, s => ({ ...s, align: value }))));
      }
      const rect = alignButton.getBoundingClientRect();
      picker.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    });
    insert(alignButton);

    const boldButton = this.makeButton("bold", "Bold", allBold);
    boldButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.updateSelection(canvas, s => ({ ...s, bold: !allBold }));
    });
    insert(boldButton);

    const italicButton = this.makeButton("italic", "Italic", allItalic);
    italicButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.updateSelection(canvas, s => ({ ...s, italic: !allItalic }));
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
