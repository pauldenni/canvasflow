import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

interface CanvasFlowSettings {
  enabledByDefault: boolean;
  focusCardOnClick: boolean;
  lockHorizontal: boolean;
  reverseVerticalScroll: boolean;
  verticalScrollSpeed: number;
  targetZoom: number;
  showStatusPill: boolean;
  showBackButton: boolean;
  exitFocusOnEscape: boolean;
  exitFocusOnBackgroundClick: boolean;
}

const DEFAULT_SETTINGS: CanvasFlowSettings = {
  enabledByDefault: false,
  focusCardOnClick: true,
  lockHorizontal: true,
  reverseVerticalScroll: true,
  verticalScrollSpeed: 1,
  targetZoom: 1.1,
  showStatusPill: true,
  showBackButton: true,
  exitFocusOnEscape: true,
  exitFocusOnBackgroundClick: true,
};

type CanvasView = any;
type CanvasObject = any;

export default class CanvasFlowPlugin extends Plugin {
  settings: CanvasFlowSettings;

  private flowEnabled = false;
  private focusedNodeEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private backButtonEl: HTMLElement | null = null;
  private lastKnownX: number | null = null;
  private viewportStack: Array<{ x: number; y: number; zoom: number }> = [];

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new CanvasFlowSettingTab(this.app, this));

    this.addRibbonIcon("move-vertical", "Toggle CanvasFlow", () => {
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
      name: "Zoom back out one level",
      callback: () => this.zoomBackOut(),
    });

    this.addCommand({
      id: "show-canvasflow-diagnostics",
      name: "Show CanvasFlow diagnostics",
      callback: () => this.showCanvasDiagnostics(),
    });

    this.registerDomEvent(document, "click", (evt: MouseEvent) => this.handleDocumentClick(evt), true);
    this.registerDomEvent(document, "wheel", (evt: WheelEvent) => this.handleWheel(evt), { capture: true, passive: false } as AddEventListenerOptions);
    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => this.handleKeydown(evt), true);

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enabledByDefault) {
        this.enableFlowMode();
      }
    });
  }

  onunload() {
    this.disableFlowMode();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    this.viewportStack = [];
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

  private handleDocumentClick(evt: MouseEvent) {
    if (!this.flowEnabled) return;

    const target = evt.target as HTMLElement | null;
    if (!target) return;

    if (target.closest(".canvasflow-back-button")) {
      evt.preventDefault();
      evt.stopPropagation();
      this.zoomBackOut();
      return;
    }

    const nodeEl = target.closest(".canvas-node") as HTMLElement | null;

    if (!nodeEl) {
      const clickedCanvasBackground = !!target.closest(".canvas-wrapper, .canvas");
      if (clickedCanvasBackground && this.settings.exitFocusOnBackgroundClick && this.viewportStack.length > 0) {
        this.zoomBackOut();
      }
      return;
    }

    if (!this.settings.focusCardOnClick) return;

    this.setFocusedNode(nodeEl);

    window.setTimeout(() => {
      const current = this.getCurrentViewport();
      if (current) this.viewportStack.push(current);
      this.focusElement(nodeEl);
      this.updateBackButton();
      this.updateStatusPill();
    }, 0);
  }

  private handleWheel(evt: WheelEvent) {
    if (!this.flowEnabled) return;

    const target = evt.target as HTMLElement | null;
    const isCanvas = !!target?.closest(".canvas-wrapper, .canvas");
    if (!isCanvas) return;

    const canvas = this.getCanvasObject();
    if (!canvas) return;

    if (this.settings.lockHorizontal) {
      evt.preventDefault();
      evt.stopPropagation();

      const direction = this.settings.reverseVerticalScroll ? -1 : 1;
      const verticalDelta = evt.deltaY * this.settings.verticalScrollSpeed * direction;

      this.panCanvasVertically(canvas, verticalDelta);
      this.restoreHorizontalPosition(canvas);
    }
  }

  private handleKeydown(evt: KeyboardEvent) {
    if (!this.flowEnabled || !this.settings.exitFocusOnEscape) return;

    if ((evt.key === "Escape" || evt.key === "Backspace") && this.viewportStack.length > 0) {
      evt.preventDefault();
      evt.stopPropagation();
      this.zoomBackOut();
    }
  }

  private getCurrentViewport(): { x: number; y: number; zoom: number } | null {
    const canvas = this.getCanvasObject();
    if (!canvas) return null;

    const viewport = canvas.viewport ?? canvas.viewPort ?? canvas;
    const x = viewport.x ?? canvas.x;
    const y = viewport.y ?? canvas.y;
    const zoom = viewport.zoom ?? canvas.zoom;

    if (typeof x === "number" && typeof y === "number" && typeof zoom === "number") {
      return { x, y, zoom };
    }

    return null;
  }

  private zoomBackOut() {
    const canvas = this.getCanvasObject();
    const previous = this.viewportStack.pop();

    if (!canvas || !previous) {
      this.clearFocusedNode();
      this.updateBackButton();
      this.updateStatusPill();
      return;
    }

    this.animateViewport(canvas, previous.x, previous.y, previous.zoom);
    this.lastKnownX = previous.x;

    if (this.viewportStack.length === 0) {
      this.clearFocusedNode();
    }

    this.updateBackButton();
    this.updateStatusPill();
  }

  private animateViewport(canvas: CanvasObject, x: number, y: number, zoom: number) {
    const start = this.getCurrentViewport();

    if (!start || typeof canvas.setViewport !== "function") {
      if (typeof canvas.setViewport === "function") {
        canvas.setViewport(x, y, zoom);
      }
      return;
    }

    const duration = 220;
    const startedAt = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeOutCubic(progress);

      const nextX = start.x + (x - start.x) * eased;
      const nextY = start.y + (y - start.y) * eased;
      const nextZoom = start.zoom + (zoom - start.zoom) * eased;

      canvas.setViewport(nextX, nextY, nextZoom);

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }

  private panCanvasVertically(canvas: CanvasObject, deltaY: number) {
    const viewport = canvas.viewport ?? canvas.viewPort ?? canvas;
    const currentX = viewport.x ?? canvas.x ?? 0;
    const currentY = viewport.y ?? canvas.y ?? 0;
    const zoom = viewport.zoom ?? canvas.zoom ?? this.settings.targetZoom;

    if (this.lastKnownX === null) this.lastKnownX = currentX;

    if (typeof canvas.setViewport === "function") {
      canvas.setViewport(this.lastKnownX, currentY - deltaY, zoom);
      return;
    }

    if (typeof canvas.panTo === "function") {
      canvas.panTo(this.lastKnownX, currentY - deltaY);
      return;
    }

    if (typeof canvas.setPan === "function") {
      canvas.setPan(this.lastKnownX, currentY - deltaY);
    }
  }

  private restoreHorizontalPosition(canvas: CanvasObject) {
    if (this.lastKnownX === null) return;

    const viewport = canvas.viewport ?? canvas.viewPort ?? canvas;
    const currentY = viewport.y ?? canvas.y ?? 0;
    const zoom = viewport.zoom ?? canvas.zoom ?? this.settings.targetZoom;

    if (typeof canvas.setViewport === "function") {
      canvas.setViewport(this.lastKnownX, currentY, zoom);
    }
  }

  private focusSelectedCanvasCard() {
    const selected = document.querySelector(".canvas-node.is-selected, .canvas-node.mod-selected, .canvas-node.canvas-node-selected") as HTMLElement | null;

    if (!selected) {
      new Notice("No selected Canvas card found");
      return;
    }

    const current = this.getCurrentViewport();
    if (current) this.viewportStack.push(current);

    this.setFocusedNode(selected);
    this.focusElement(selected);
    this.updateBackButton();
    this.updateStatusPill();
  }

  private focusElement(nodeEl: HTMLElement) {
    const canvas = this.getCanvasObject();
    const rect = nodeEl.getBoundingClientRect();

    if (canvas) {
      const nodeId = nodeEl.getAttribute("data-node-id") ?? nodeEl.dataset.nodeId;
      const node = nodeId && canvas.nodes instanceof Map ? canvas.nodes.get(nodeId) : null;

      if (node && typeof canvas.zoomToSelection === "function") {
        try {
          canvas.selection = new Set([node]);
          canvas.zoomToSelection();
          this.captureCurrentHorizontalPosition(canvas);
          return;
        } catch {}
      }

      if (node && typeof canvas.zoomToNode === "function") {
        try {
          canvas.zoomToNode(node);
          this.captureCurrentHorizontalPosition(canvas);
          return;
        } catch {}
      }

      if (node?.x !== undefined && node?.y !== undefined && typeof canvas.setViewport === "function") {
        try {
          const viewport = canvas.viewport ?? canvas.viewPort ?? canvas;
          const currentZoom = viewport.zoom ?? canvas.zoom ?? this.settings.targetZoom;
          const zoom = this.settings.targetZoom || currentZoom || 1;

          const x = Number(node.x);
          const y = Number(node.y);
          const width = Number(node.width ?? rect.width ?? 800);
          const height = Number(node.height ?? rect.height ?? 500);

          this.lastKnownX = -x + width / 2;
          this.animateViewport(canvas, this.lastKnownX, -y + height / 2, zoom);
          return;
        } catch {}
      }

      if (node && typeof canvas.selectOnly === "function") {
        try {
          canvas.selectOnly(node);
        } catch {}
      }
    }

    nodeEl.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }

  private captureCurrentHorizontalPosition(canvas: CanvasObject) {
    const viewport = canvas.viewport ?? canvas.viewPort ?? canvas;
    const currentX = viewport.x ?? canvas.x ?? null;
    if (typeof currentX === "number") {
      this.lastKnownX = currentX;
    }
  }

  private setFocusedNode(nodeEl: HTMLElement) {
    this.clearFocusedNode();
    this.focusedNodeEl = nodeEl;
    this.focusedNodeEl.classList.add("canvasflow-active-node");
    this.updateStatusPill();
  }

  private clearFocusedNode() {
    this.focusedNodeEl?.classList.remove("canvasflow-active-node");
    this.focusedNodeEl = null;
  }

  private updateStatusPill() {
    if (!this.flowEnabled || !this.settings.showStatusPill) return;

    if (!this.statusEl) {
      this.statusEl = document.createElement("div");
      this.statusEl.className = "canvasflow-status";
      document.body.appendChild(this.statusEl);
    }

    const focused = this.focusedNodeEl ? " • focused" : "";
    const depth = this.viewportStack.length > 0 ? ` • ${this.viewportStack.length} level${this.viewportStack.length === 1 ? "" : "s"}` : "";
    this.statusEl.textContent = `CanvasFlow${focused}${depth}`;
  }

  private removeStatusPill() {
    this.statusEl?.remove();
    this.statusEl = null;
  }

  private updateBackButton() {
    if (!this.flowEnabled || !this.settings.showBackButton || this.viewportStack.length === 0) {
      this.removeBackButton();
      return;
    }

    if (!this.backButtonEl) {
      this.backButtonEl = document.createElement("button");
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
      .setName("Lock horizontal movement")
      .setDesc("Attempts to make mouse wheel movement vertical-only while in CanvasFlow.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.lockHorizontal)
        .onChange(async value => {
          this.plugin.settings.lockHorizontal = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Reverse vertical scroll direction")
      .setDesc("Matches CanvasFlow scrolling to native Canvas feel. Turn this off if the direction feels backwards on your device.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.reverseVerticalScroll)
        .onChange(async value => {
          this.plugin.settings.reverseVerticalScroll = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Vertical scroll speed")
      .setDesc("Multiplier for wheel-based vertical movement.")
      .addSlider(slider => slider
        .setLimits(0.25, 3, 0.25)
        .setValue(this.plugin.settings.verticalScrollSpeed)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.verticalScrollSpeed = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Target zoom")
      .setDesc("Preferred zoom level when focusing a card.")
      .addSlider(slider => slider
        .setLimits(0.5, 2, 0.1)
        .setValue(this.plugin.settings.targetZoom)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.targetZoom = value;
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
        }));

    new Setting(containerEl)
      .setName("Show back button")
      .setDesc("Shows a floating button while focused so users can return to the previous Canvas view.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showBackButton)
        .onChange(async value => {
          this.plugin.settings.showBackButton = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Escape/Backspace exits focus")
      .setDesc("Press Escape or Backspace to zoom back out one level.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.exitFocusOnEscape)
        .onChange(async value => {
          this.plugin.settings.exitFocusOnEscape = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Background click exits focus")
      .setDesc("Click the Canvas background to zoom back out one level.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.exitFocusOnBackgroundClick)
        .onChange(async value => {
          this.plugin.settings.exitFocusOnBackgroundClick = value;
          await this.plugin.saveSettings();
        }));
  }
}