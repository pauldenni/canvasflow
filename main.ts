import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { CardTools } from "./src/cardTools";
import { canvasToMermaid } from "./src/mermaidExport";
import { mermaidToCanvas } from "./src/mermaidImport";
import { MERMAID_VIEW_TYPE, MermaidPanel } from "./src/mermaidPanel";

interface CanvasFlowSettings {
  enabledByDefault: boolean;
  focusCardOnClick: boolean;
  /** Percent of the screen a focused card should fill. */
  focusSize: number;
  showStatusPill: boolean;
  showBackButton: boolean;
  exitFocusOnEscape: boolean;
  showCardFormatting: boolean;
  /** Line labels stay a readable size when zoomed out (Obsidian's default). Off: they shrink with the canvas. */
  keepLabelsReadable: boolean;
}

const DEFAULT_SETTINGS: CanvasFlowSettings = {
  enabledByDefault: false,
  focusCardOnClick: true,
  focusSize: 50,
  showStatusPill: true,
  showBackButton: true,
  exitFocusOnEscape: true,
  showCardFormatting: true,
  keepLabelsReadable: true,
};

const LABELS_ZOOM_CLASS = "canvasflow-labels-zoom";

type CanvasView = any;
type CanvasObject = any;
type Viewport = { x: number; y: number; zoom: number };

/** Never zoom past 200% when focusing, so small cards don't blow up. */
const MAX_FOCUS_SCALE = 2;
const GLIDE_DURATION_MS = 550;
/** Deepest mid-glide pull-back, in log2 zoom units (0.35 is about 22% further out). */
const MAX_PULL_BACK = 0.35;
/** Pointer movement beyond this between press and release counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 5;

export default class CanvasFlowPlugin extends Plugin {
  settings: CanvasFlowSettings;
  cardTools: CardTools;

  private flowEnabled = false;
  private focusedNodeEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private backButtonEl: HTMLButtonElement | null = null;
  /** The view from before you focused a card. Set while a card is focused; Escape and "Back to canvas" then zoom out to fit every card. */
  private returnView: Viewport | null = null;
  private pointerDownAt: { x: number; y: number } | null = null;
  private panFrame: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new CanvasFlowSettingTab(this.app, this));

    this.cardTools = new CardTools(this, () => this.settings.showCardFormatting);
    this.cardTools.load();

    this.applyLabelScaling();
    this.register(() => document.body.classList.remove(LABELS_ZOOM_CLASS));

    this.addRibbonIcon("focus", "Toggle CanvasFlow", () => {
      this.toggleFlowMode();
    });

    this.addCommand({
      id: "toggle-canvasflow",
      name: "Toggle CanvasFlow Mode",
      callback: () => this.toggleFlowMode(),
    });

    this.addCommand({
      id: "focus-selected-canvas-card",
      name: "Focus selected Canvas card",
      callback: () => this.focusSelectedCanvasCard(),
    });

    this.addCommand({
      id: "zoom-back-out",
      name: "Back to canvas (exit focus)",
      callback: () => this.exitFocus(),
    });

    this.addCommand({
      id: "show-canvasflow-diagnostics",
      name: "Show CanvasFlow diagnostics",
      callback: () => this.showCanvasDiagnostics(),
    });

    this.addCommand({
      id: "copy-as-mermaid",
      name: "Copy canvas as Mermaid",
      callback: () => this.copyAsMermaid(false),
    });

    this.addCommand({
      id: "copy-as-mermaid-block",
      name: "Copy canvas as Mermaid code block (for notes)",
      callback: () => this.copyAsMermaid(true),
    });

    this.registerView(MERMAID_VIEW_TYPE, leaf => new MermaidPanel(leaf));

    this.addCommand({
      id: "open-mermaid-panel",
      name: "Open Mermaid code panel",
      callback: () => this.openMermaidPanel(),
    });

    this.addCommand({
      id: "add-mermaid-flowchart",
      name: "Add Mermaid flowchart to canvas",
      callback: () => this.openMermaidImport(),
    });

    this.registerDomEvent(document, "pointerdown", (evt: PointerEvent) => this.handlePointerDown(evt), true);
    this.registerDomEvent(document, "click", (evt: MouseEvent) => this.handleDocumentClick(evt), true);
    this.registerDomEvent(document, "wheel", (evt: WheelEvent) => this.handleWheel(evt), { capture: true, passive: false });
    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => this.handleKeydown(evt), true);

    // The pill and back button belong to the canvas, so hide them when you switch to a note.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshOverlays()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshOverlays()));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enabledByDefault) {
        this.enableFlowMode();
      }
    });
  }

  onunload() {
    this.cancelPan();
    this.disableFlowMode();
  }

  async loadSettings() {
    // Only keep current settings, so options removed in later versions drop out of data.json.
    const saved = (await this.loadData()) ?? {};
    const settings: any = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in saved) settings[key] = saved[key];
    }
    this.settings = settings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** styles.css does the rest: with this class, line labels shrink and grow like card text. */
  applyLabelScaling() {
    document.body.classList.toggle(LABELS_ZOOM_CLASS, !this.settings.keepLabelsReadable);
  }

  private toggleFlowMode() {
    if (this.flowEnabled) this.disableFlowMode();
    else this.enableFlowMode();
  }

  private enableFlowMode() {
    this.flowEnabled = true;
    document.body.classList.add("canvasflow-enabled");
    this.updateStatusPill();
    new Notice("CanvasFlow enabled");
  }

  private disableFlowMode() {
    this.flowEnabled = false;
    document.body.classList.remove("canvasflow-enabled");
    this.clearFocusedNode();
    this.removeStatusPill();
    this.removeBackButton();
    this.returnView = null;
    new Notice("CanvasFlow disabled");
  }

  private getActiveCanvasView(): CanvasView | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeView = activeLeaf?.view as any;

    if (activeView?.getViewType?.() === "canvas") return activeView;
    return null;
  }

  /**
   * True when the tab you're working in is a canvas. Uses the most recent tab
   * in the main area, so clicking into a sidebar doesn't count as leaving.
   */
  private isCanvasShowing(): boolean {
    const leaf = this.app.workspace.getMostRecentLeaf();
    return (leaf?.view as any)?.getViewType?.() === "canvas";
  }

  private getCanvasObject(): CanvasObject | null {
    const view = this.getActiveCanvasView();
    return view?.canvas ?? null;
  }

  private handlePointerDown(evt: PointerEvent) {
    this.pointerDownAt = { x: evt.clientX, y: evt.clientY };
    this.cancelPan();
  }

  /** True when the pointer moved between press and release, i.e. the user dragged the canvas or a card. */
  private wasDrag(evt: MouseEvent): boolean {
    const start = this.pointerDownAt;
    if (!start) return false;
    return Math.hypot(evt.clientX - start.x, evt.clientY - start.y) > DRAG_THRESHOLD_PX;
  }

  private handleDocumentClick(evt: MouseEvent) {
    if (!this.flowEnabled) return;

    const target = evt.target as HTMLElement | null;
    if (!target) return;

    if (target.closest(".canvasflow-back-button")) {
      evt.preventDefault();
      evt.stopPropagation();
      this.exitFocus();
      return;
    }

    // Moving a card ends in a click; that's not a request to focus it.
    if (this.wasDrag(evt)) return;

    // Only clicks on cards do anything. The blank canvas, the card action bar and other controls are left to Obsidian.
    if (target.closest(".canvas-menu-container, .canvas-menu, .canvas-controls, .canvas-card-menu, .menu")) return;

    const nodeEl = target.closest(".canvas-node") as HTMLElement | null;
    if (!nodeEl) return;

    if (!this.settings.focusCardOnClick) return;

    // Second click of a double-click (which opens the card for editing), or clicks while editing.
    if (evt.detail > 1) return;
    if (nodeEl.classList.contains("is-editing") || target.closest(".cm-editor, .markdown-source-view")) return;

    const canvas = this.getCanvasObject();
    const node = canvas ? this.findNodeForElement(canvas, nodeEl) : null;
    if (!canvas || !node) return;

    window.setTimeout(() => this.focusNode(canvas, node), 0);
  }

  private handleKeydown(evt: KeyboardEvent) {
    if (!this.flowEnabled || !this.settings.exitFocusOnEscape) return;

    const target = evt.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;

    // Delete/Backspace are left to Obsidian, which deletes the selected cards.
    if (evt.key === "Escape" && this.returnView) {
      evt.preventDefault();
      evt.stopPropagation();
      this.exitFocus();
    }
  }

  /**
   * Obsidian's canvas animates toward a target viewport (tx, ty, tZoom); x, y
   * and zoom are the in-between values. Read the target so we never save a
   * position from the middle of an animation. x/y are the canvas point at the
   * center of the screen; zoom is log2 of the scale (0 = 100%).
   */
  private getCurrentViewport(): Viewport | null {
    const canvas = this.getCanvasObject();
    if (!canvas) return null;

    const x = canvas.tx ?? canvas.x;
    const y = canvas.ty ?? canvas.y;
    const zoom = canvas.tZoom ?? canvas.zoom;

    if (typeof x === "number" && typeof y === "number" && typeof zoom === "number") {
      return { x, y, zoom };
    }

    return null;
  }

  /**
   * Glide the canvas to a viewport. Used for every focus and back move so they
   * all look the same.
   *
   * We animate ourselves instead of using Obsidian's built-in animation: that
   * one skips pans that don't change the zoom (it jumps in one frame), and
   * leftover trackpad momentum makes it jump to the end.
   *
   * For moves at a similar zoom (card to card), the camera pulls back a little
   * in the middle so you can see where it's going.
   */
  private moveViewport(canvas: CanvasObject, to: Viewport) {
    this.cancelPan();

    const from = this.getCurrentViewport();
    if (!from || typeof canvas.setViewport !== "function") {
      if (typeof canvas.markViewportChanged === "function") {
        canvas.tx = to.x;
        canvas.ty = to.y;
        canvas.tZoom = to.zoom;
        canvas.zoomCenter = null;
        canvas.markViewportChanged();
      }
      return;
    }

    // Pull-back depth (log2 zoom units): grows with how far we travel on screen,
    // fades out for moves that already zoom a lot.
    const rect = canvas.canvasRect ?? canvas.wrapperEl?.getBoundingClientRect?.();
    const screenDistance = Math.hypot(to.x - from.x, to.y - from.y) * Math.pow(2, from.zoom);
    const travel = rect?.width ? Math.min(1, screenDistance / rect.width) : 0;
    const zoomChange = Math.abs(to.zoom - from.zoom);
    const pullBack = MAX_PULL_BACK * travel * Math.max(0, 1 - zoomChange / 0.5);

    const startedAt = performance.now();
    const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - startedAt) / GLIDE_DURATION_MS));
      const k = easeInOutCubic(t);
      canvas.setViewport(
        from.x + (to.x - from.x) * k,
        from.y + (to.y - from.y) * k,
        from.zoom + (to.zoom - from.zoom) * k - pullBack * Math.sin(Math.PI * t),
      );
      this.panFrame = t < 1 ? window.requestAnimationFrame(step) : null;
    };

    this.panFrame = window.requestAnimationFrame(step);
  }

  private cancelPan() {
    if (this.panFrame !== null) window.cancelAnimationFrame(this.panFrame);
    this.panFrame = null;
  }

  /** Swallow scrolls during a glide so trackpad momentum can't knock it off course. */
  private handleWheel(evt: WheelEvent) {
    if (this.panFrame === null) return;
    if (!(evt.target as HTMLElement | null)?.closest?.(".canvas-wrapper")) return;
    evt.preventDefault();
    evt.stopPropagation();
  }

  /**
   * The view that fits every card, worked out the same way as Obsidian's
   * "Zoom to fit" (10% margin, never past 100%), so we can glide there.
   */
  private getFitViewport(canvas: CanvasObject): Viewport | null {
    const rect = canvas.canvasRect ?? canvas.wrapperEl?.getBoundingClientRect?.();
    const nodes: any[] = canvas.nodes ? Array.from(canvas.nodes.values()) : [];
    if (!rect?.width || !rect?.height || nodes.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const bbox = this.getNodeBBox(node);
      if (!bbox) continue;
      minX = Math.min(minX, bbox.minX);
      minY = Math.min(minY, bbox.minY);
      maxX = Math.max(maxX, bbox.maxX);
      maxY = Math.max(maxY, bbox.maxY);
    }
    if (!Number.isFinite(minX)) return null;

    const scale = Math.min(
      rect.width / (1.1 * Math.max(1, maxX - minX)),
      rect.height / (1.1 * Math.max(1, maxY - minY)),
      1,
    );
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: Math.log2(scale) };
  }

  /** Leave focus and zoom out to show every card. */
  private exitFocus() {
    const canvas = this.getCanvasObject();
    const previous = this.returnView;
    this.returnView = null;

    // An empty canvas has nothing to fit, so fall back to the view from before focusing.
    const target = canvas ? (this.getFitViewport(canvas) ?? previous) : null;
    if (canvas && target) this.moveViewport(canvas, target);

    // We've left that card's view, so clicking it again should focus it again.
    this.clearFocusedNode();
    this.updateBackButton();
    this.updateStatusPill();
  }

  private focusSelectedCanvasCard() {
    const canvas = this.getCanvasObject();
    const selected = canvas?.selection ? Array.from(canvas.selection as Set<any>).find((item: any) => item?.nodeEl) : null;

    if (!canvas || !selected) {
      new Notice("Select a Canvas card first");
      return;
    }

    this.focusNode(canvas, selected);
  }

  /**
   * Zoom so the card fills `focusSize`% of the screen (capped at 200% zoom for
   * small cards) and center it, regardless of the current zoom level.
   */
  private focusNode(canvas: CanvasObject, node: any) {
    const bbox = this.getNodeBBox(node);
    const rect = canvas.canvasRect ?? canvas.wrapperEl?.getBoundingClientRect?.();
    if (!bbox || !rect || !rect.width || !rect.height) return;

    // Moving from card to card keeps the original view, so one Escape gets you all the way out.
    if (!this.returnView) this.returnView = this.getCurrentViewport();

    const fill = this.settings.focusSize / 100;
    const width = Math.max(1, bbox.maxX - bbox.minX);
    const height = Math.max(1, bbox.maxY - bbox.minY);
    const scale = Math.min((rect.width * fill) / width, (rect.height * fill) / height, MAX_FOCUS_SCALE);

    this.moveViewport(canvas, {
      x: (bbox.minX + bbox.maxX) / 2,
      y: (bbox.minY + bbox.maxY) / 2,
      zoom: Math.log2(scale),
    });

    if (node.nodeEl) this.setFocusedNode(node.nodeEl);
    this.updateBackButton();
    this.updateStatusPill();
  }

  private getNodeBBox(node: any): { minX: number; minY: number; maxX: number; maxY: number } | null {
    try {
      const bbox = node.getBBox?.();
      if (bbox && [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].every((v: unknown) => typeof v === "number")) return bbox;
    } catch {}

    const { x, y, width, height } = node ?? {};
    if ([x, y, width, height].every((v: unknown) => typeof v === "number")) {
      return { minX: x, minY: y, maxX: x + width, maxY: y + height };
    }
    return null;
  }

  private findNodeForElement(canvas: CanvasObject, nodeEl: HTMLElement): any | null {
    if (!(canvas.nodes instanceof Map)) return null;
    for (const node of canvas.nodes.values()) {
      if (node?.nodeEl === nodeEl) return node;
    }
    return null;
  }

  private setFocusedNode(nodeEl: HTMLElement) {
    this.clearFocusedNode();
    this.focusedNodeEl = nodeEl;
    this.updateStatusPill();
  }

  private clearFocusedNode() {
    this.focusedNodeEl = null;
  }

  /** Show or hide the status pill and back button to match the current settings and tab. */
  refreshOverlays() {
    this.updateStatusPill();
    this.updateBackButton();
  }

  private updateStatusPill() {
    if (!this.flowEnabled || !this.settings.showStatusPill || !this.isCanvasShowing()) {
      this.removeStatusPill();
      return;
    }

    if (!this.statusEl) {
      this.statusEl = document.createElement("div");
      this.statusEl.className = "canvasflow-status";
      document.body.appendChild(this.statusEl);
    }

    const focused = this.focusedNodeEl ? " • focused" : "";
    this.statusEl.textContent = `CanvasFlow${focused}`;
  }

  private removeStatusPill() {
    this.statusEl?.remove();
    this.statusEl = null;
  }

  private updateBackButton() {
    if (!this.flowEnabled || !this.settings.showBackButton || !this.returnView || !this.isCanvasShowing()) {
      this.removeBackButton();
      return;
    }

    if (!this.backButtonEl) {
      this.backButtonEl = document.createElement("button") as HTMLButtonElement;
      this.backButtonEl.className = "canvasflow-back-button";
      this.backButtonEl.type = "button";
      this.backButtonEl.textContent = "← Back to canvas";
      document.body.appendChild(this.backButtonEl);
    }
  }

  private removeBackButton() {
    this.backButtonEl?.remove();
    this.backButtonEl = null;
  }

  /**
   * Copy the canvas as a Mermaid flowchart. With cards selected, only those
   * cards and the lines between them are copied.
   */
  private async copyAsMermaid(asCodeBlock: boolean) {
    const canvas = this.getCanvasObject();
    let data: any = null;
    try { data = canvas?.getData?.(); } catch {}
    if (!canvas || !data) {
      new Notice("Open a Canvas first");
      return;
    }

    const selected = new Set<string>();
    for (const item of Array.from((canvas.selection ?? []) as Set<any>)) {
      if (item?.nodeEl && typeof item.id === "string") selected.add(item.id);
    }

    const result = canvasToMermaid(data, { onlyIds: selected });
    if (result.nodeCount === 0) {
      new Notice("Nothing to copy: the canvas has no cards");
      return;
    }

    const text = asCodeBlock ? "```mermaid\n" + result.code + "\n```\n" : result.code;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      new Notice("Couldn't copy to the clipboard");
      return;
    }

    const cards = `${result.nodeCount} ${result.nodeCount === 1 ? "card" : "cards"}`;
    const lines = `${result.edgeCount} ${result.edgeCount === 1 ? "line" : "lines"}`;
    new Notice(`Copied ${selected.size ? "selection" : "canvas"} as Mermaid (${cards}, ${lines})`);
  }

  /** Show the Mermaid code panel in the right sidebar, opening it if it isn't there yet. */
  private async openMermaidPanel() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(MERMAID_VIEW_TYPE)[0];
    if (!leaf) {
      const created = workspace.getRightLeaf(false);
      if (!created) return;
      leaf = created;
      await leaf.setViewState({ type: MERMAID_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Ask for Mermaid flowchart code (starting from the clipboard when it holds some) and add it to the canvas. */
  private async openMermaidImport() {
    const canvas = this.getCanvasObject();
    if (!canvas || typeof canvas.importData !== "function") {
      new Notice("Open a Canvas first");
      return;
    }
    if (canvas.readonly) {
      new Notice("This canvas is read-only");
      return;
    }

    let clipboard = "";
    try { clipboard = await navigator.clipboard.readText(); } catch {}
    const looksLikeFlowchart = /^\s*(```\s*mermaid\s*\n)?\s*(---[\s\S]*?---\s*)?(%%.*\n\s*)*(flowchart|graph)\b/i.test(clipboard);

    new MermaidImportModal(this.app, looksLikeFlowchart ? clipboard : "", code => this.addMermaidToCanvas(canvas, code)).open();
  }

  /**
   * Add a flowchart to the canvas as shapes, groups and lines, and select it.
   * It goes in the middle of the view, or beside the existing cards when it
   * would land on top of them. Throws when the code can't be read.
   */
  private addMermaidToCanvas(canvas: CanvasObject, code: string) {
    const center = canvas.posCenter?.() ?? { x: 0, y: 0 };
    const result = mermaidToCanvas(code, center);
    if (result.nodes.length === 0) throw new Error("The flowchart has no nodes");

    const box = (items: any[]) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const item of items) {
        minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
        maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height);
      }
      return { minX, minY, maxX, maxY };
    };
    const existing: any[] = (canvas.getData?.()?.nodes ?? []).filter((n: any) => typeof n?.x === "number");
    const added = box(result.nodes);
    const overlaps = existing.some(n =>
      n.x < added.maxX && n.x + n.width > added.minX && n.y < added.maxY && n.y + n.height > added.minY);
    if (overlaps) {
      const current = box(existing);
      const dx = Math.round(current.maxX + 120 - added.minX);
      const dy = Math.round((current.minY + current.maxY) / 2 - (added.minY + added.maxY) / 2);
      for (const node of result.nodes) { node.x += dx; node.y += dy; }
    }

    const created = canvas.importData({ nodes: result.nodes, edges: result.edges }, false);
    try {
      canvas.deselectAll?.();
      created?.forEach?.((node: any) => canvas.select?.(node));
      canvas.zoomToSelection?.();
    } catch {}
    try { canvas.requestSave?.(); } catch {}
    try { canvas.pushHistory?.(canvas.getData()); } catch {}

    const cards = `${result.cardCount} ${result.cardCount === 1 ? "card" : "cards"}`;
    const lines = `${result.edges.length} ${result.edges.length === 1 ? "line" : "lines"}`;
    new Notice(`Added Mermaid flowchart (${cards}, ${lines})`);
  }

  private showCanvasDiagnostics() {
    const view = this.getActiveCanvasView();
    const canvas = this.getCanvasObject();

    if (!view || !canvas) {
      new Notice("Open a Canvas first, then run diagnostics.");
      console.log("[CanvasFlow] No active Canvas view found.", { view, canvas });
      return;
    }

    const diagnostics = {
      viewType: view.getViewType?.(),
      viewKeys: Object.keys(view).sort(),
      canvasKeys: Object.keys(canvas).sort(),
      canvasPrototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(canvas)).sort(),
      viewport: canvas.viewport ?? canvas.viewPort ?? null,
      nodesType: canvas.nodes?.constructor?.name,
      nodeCount: canvas.nodes?.size ?? canvas.nodes?.length ?? null,
    };

    console.log("[CanvasFlow diagnostics]", diagnostics);
    new Notice("CanvasFlow diagnostics written to console");
  }
}

/** A box to paste or type Mermaid flowchart code into. Stays open, showing what's wrong, when the code can't be read. */
class MermaidImportModal extends Modal {
  constructor(app: App, private initial: string, private onSubmit: (code: string) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Add Mermaid flowchart");
    contentEl.addClass("canvasflow-mermaid-modal");

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Paste or type a Mermaid flowchart. It's added to the canvas as shapes, groups and lines that you can move and edit.",
    });

    const input = contentEl.createEl("textarea", { cls: "canvasflow-mermaid-input" });
    input.spellcheck = false;
    input.placeholder = "flowchart TD\n    A[Start] --> B{Decide}\n    B -->|Yes| C[Do it]\n    B -->|No| D[Stop]";
    input.value = this.initial;

    const errorEl = contentEl.createDiv({ cls: "canvasflow-mermaid-error" });

    const submit = () => {
      errorEl.setText("");
      try {
        this.onSubmit(input.value);
      } catch (err: any) {
        const where = typeof err?.line === "number" ? `Line ${err.line}: ` : "";
        errorEl.setText(where + (err?.message ?? "This flowchart couldn't be read"));
        return;
      }
      this.close();
    };

    new Setting(contentEl)
      .addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(button => button.setButtonText("Add to canvas").setCta().onClick(submit));

    input.addEventListener("keydown", evt => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CanvasFlowSettingTab extends PluginSettingTab {
  plugin: CanvasFlowPlugin;

  constructor(app: App, plugin: CanvasFlowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "CanvasFlow" });

    new Setting(containerEl)
      .setName("Card text formatting")
      .setDesc("Adds align, bold, italic and shape buttons to the action bar when you select a text card. Works whether or not CanvasFlow mode is on. The lock button and the Add shape button at the bottom of the canvas are always shown.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCardFormatting)
        .onChange(async value => {
          this.plugin.settings.showCardFormatting = value;
          await this.plugin.saveSettings();
          this.plugin.cardTools.refreshAll();
        }));

    new Setting(containerEl)
      .setName("Keep line labels readable when zoomed out")
      .setDesc("On: line labels stay a readable size however far you zoom out (Obsidian's default), which can make them look large next to the cards. Off: labels shrink and grow with the canvas, like the text on cards, and hide once you zoom out far enough that cards show placeholders.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.keepLabelsReadable)
        .onChange(async value => {
          this.plugin.settings.keepLabelsReadable = value;
          await this.plugin.saveSettings();
          this.plugin.applyLabelScaling();
        }));

    new Setting(containerEl)
      .setName("Enable by default")
      .setDesc("Automatically enable CanvasFlow when Obsidian starts.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabledByDefault)
        .onChange(async value => {
          this.plugin.settings.enabledByDefault = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Focus card on click")
      .setDesc("Clicking a Canvas card automatically brings it into focus while CanvasFlow is enabled.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.focusCardOnClick)
        .onChange(async value => {
          this.plugin.settings.focusCardOnClick = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Focused card size")
      .setDesc("How much of the screen a card fills when you click it in CanvasFlow mode. Small cards stop growing at 200% zoom.")
      .addSlider(slider => slider
        .setLimits(20, 90, 5)
        .setValue(this.plugin.settings.focusSize)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.focusSize = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Show status pill")
      .setDesc("Show a small CanvasFlow indicator while enabled.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showStatusPill)
        .onChange(async value => {
          this.plugin.settings.showStatusPill = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOverlays();
        }));

    new Setting(containerEl)
      .setName("Show back button")
      .setDesc("Shows a floating button while focused so users can return to the previous Canvas view.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showBackButton)
        .onChange(async value => {
          this.plugin.settings.showBackButton = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOverlays();
        }));

    new Setting(containerEl)
      .setName("Escape exits focus")
      .setDesc("Press Escape to leave focus and zoom out to show every card.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.exitFocusOnEscape)
        .onChange(async value => {
          this.plugin.settings.exitFocusOnEscape = value;
          await this.plugin.saveSettings();
        }));
  }
}