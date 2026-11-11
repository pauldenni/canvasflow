import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { CardTools } from "./src/cardTools";

interface CanvasFlowSettings {
  enabledByDefault: boolean;
  focusCardOnClick: boolean;
  /** Percent of the screen a focused card should fill. */
  focusSize: number;
  showStatusPill: boolean;
  showBackButton: boolean;
  exitFocusOnEscape: boolean;
  showCardFormatting: boolean;
}

const DEFAULT_SETTINGS: CanvasFlowSettings = {
  enabledByDefault: false,
  focusCardOnClick: true,
  focusSize: 50,
  showStatusPill: true,
  showBackButton: true,
  exitFocusOnEscape: true,
  showCardFormatting: true,
};

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
  /** The view from before you focused a card; Escape and "Back to canvas" return here. */
  private returnView: Viewport | null = null;
  private pointerDownAt: { x: number; y: number } | null = null;
  private panFrame: number | null = null;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new CanvasFlowSettingTab(this.app, this));

    this.cardTools = new CardTools(this, () => this.settings.showCardFormatting);
    this.cardTools.load();

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

    this.registerDomEvent(document, "pointerdown", (evt: PointerEvent) => this.handlePointerDown(evt), true);
    this.registerDomEvent(document, "click", (evt: MouseEvent) => this.handleDocumentClick(evt), true);
    this.registerDomEvent(document, "wheel", (evt: WheelEvent) => this.handleWheel(evt), { capture: true, passive: false });
    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => this.handleKeydown(evt), true);

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

  /** Leave focus and return to the view you had before focusing any card. */
  private exitFocus() {
    const canvas = this.getCanvasObject();
    const previous = this.returnView;
    this.returnView = null;

    if (canvas && previous) this.moveViewport(canvas, previous);

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

  /** Show or hide the status pill and back button to match the current settings. */
  refreshOverlays() {
    this.updateStatusPill();
    this.updateBackButton();
  }

  private updateStatusPill() {
    if (!this.flowEnabled || !this.settings.showStatusPill) {
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
    if (!this.flowEnabled || !this.settings.showBackButton || !this.returnView) {
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
      .setDesc("Press Escape to leave focus and return to the view you had before.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.exitFocusOnEscape)
        .onChange(async value => {
          this.plugin.settings.exitFocusOnEscape = value;
          await this.plugin.saveSettings();
        }));
  }
}