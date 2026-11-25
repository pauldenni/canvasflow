/**
 * The Mermaid code panel: a sidebar view showing the canvas you're working on
 * as Mermaid flowchart code, live in both directions.
 *
 * - Draw on the canvas and the code updates.
 * - Edit the code and the canvas updates, a moment after you stop typing.
 *
 * The canvas is the source of truth. The code is regenerated from it, so while
 * you type the text is yours, but once you click away it's rewritten in the
 * panel's own layout (your comments and line order aren't kept). Code that
 * can't be read is never applied: the panel says what's wrong and the canvas
 * stays as it was.
 */

import { ItemView, Notice, TFile, WorkspaceLeaf, debounce, setIcon, setTooltip } from "obsidian";
import { canvasToMermaid } from "./mermaidExport";
import { syncCanvasFromMermaid } from "./mermaidSync";

type AnyObj = any;

export const MERMAID_VIEW_TYPE = "canvasflow-mermaid";

/** How long after the last keystroke the code is applied to the canvas. */
const APPLY_DELAY_MS = 600;
/** How long after a canvas change the code is regenerated. */
const REFRESH_DELAY_MS = 150;

type Status = "ok" | "error" | "warning" | "muted";

export class MermaidPanel extends ItemView {
  private input: HTMLTextAreaElement;
  private fileNameEl: HTMLElement;
  private statusEl: HTMLElement;
  private statusTextEl: HTMLElement;
  private statusButtonEl: HTMLButtonElement;
  private emptyEl: HTMLElement;
  private bodyEl: HTMLElement;

  /** The canvas tab the panel is showing. */
  private target: WorkspaceLeaf | null = null;
  private targetPath: string | null = null;
  /** Undoes the hook on the target's save, which is how the panel hears about changes. */
  private unhook: (() => void) | null = null;
  /** The code the canvas last generated. Unchanged means nothing the code shows has changed. */
  private lastGenerated: string | null = null;
  /** You've typed since the code was last written by the panel. */
  private dirty = false;
  private hasError = false;
  /** Names handed out to cards with none saved, per canvas file, so they don't change while the panel is open. */
  private names = new Map<string, Map<string, string>>();

  private refreshSoon = debounce(() => this.refreshFromCanvas(), REFRESH_DELAY_MS, true);
  private applySoon = debounce(() => this.applyCode(false), APPLY_DELAY_MS, true);

  getViewType(): string { return MERMAID_VIEW_TYPE; }
  getDisplayText(): string { return "Mermaid code"; }
  getIcon(): string { return "workflow"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("canvasflow-mermaid-panel");

    this.emptyEl = root.createDiv({
      cls: "canvasflow-mermaid-empty",
      text: "Open a canvas to see it as Mermaid code.",
    });

    this.bodyEl = root.createDiv({ cls: "canvasflow-mermaid-body" });
    const header = this.bodyEl.createDiv({ cls: "canvasflow-mermaid-header" });
    this.fileNameEl = header.createDiv({ cls: "canvasflow-mermaid-title" });
    const copy = header.createEl("button", { cls: "clickable-icon" });
    setIcon(copy, "copy");
    setTooltip(copy, "Copy the code");
    copy.setAttribute("aria-label", "Copy the code");
    copy.addEventListener("click", () => this.copyCode());

    this.input = this.bodyEl.createEl("textarea", { cls: "canvasflow-mermaid-input canvasflow-mermaid-code" });
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "Mermaid code for this canvas");
    this.input.addEventListener("input", () => {
      this.dirty = true;
      this.applySoon();
    });
    // Once you click away, show the code as the canvas has it.
    this.input.addEventListener("blur", () => {
      if (!this.dirty) return;
      // Apply what's typed first, in case you clicked away before the pause ran out.
      this.applySoon.cancel();
      this.applyCode(false);
      if (!this.hasError) this.refreshFromCanvas(true, true);
    });
    this.input.addEventListener("keydown", evt => {
      if (evt.key !== "Tab" || evt.metaKey || evt.ctrlKey || evt.altKey) return;
      evt.preventDefault();
      this.input.setRangeText("    ", this.input.selectionStart, this.input.selectionEnd, "end");
      this.input.dispatchEvent(new Event("input"));
    });

    this.statusEl = this.bodyEl.createDiv({ cls: "canvasflow-mermaid-status" });
    this.statusTextEl = this.statusEl.createSpan();
    this.statusButtonEl = this.statusEl.createEl("button", { text: "Apply anyway" });
    this.statusButtonEl.addEventListener("click", () => this.applyCode(true));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.pickTarget()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.pickTarget()));
    // Catches changes that don't come through the canvas itself (sync, another window).
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile && file === this.targetFile()) this.refreshSoon();
    }));

    this.pickTarget();
  }

  async onClose() {
    this.unhook?.();
    this.unhook = null;
    this.target = null;
  }

  private targetCanvas(): AnyObj | null {
    const view = this.target?.view as AnyObj;
    return view?.getViewType?.() === "canvas" ? view.canvas ?? null : null;
  }

  private targetFile(): TFile | null {
    return (this.target?.view as AnyObj)?.file ?? null;
  }

  private namesFor(): Map<string, string> {
    const key = this.targetFile()?.path ?? "";
    let names = this.names.get(key);
    if (!names) this.names.set(key, (names = new Map()));
    return names;
  }

  /** Follow the tab you're working in: the most recent one in the main area, if it's a canvas. */
  private pickTarget() {
    const { workspace } = this.app;
    let leaf = workspace.getMostRecentLeaf();
    // Clicking into a sidebar (this panel included) isn't leaving the canvas.
    if (leaf && leaf.getRoot() !== workspace.rootSplit) {
      leaf = this.target && workspace.getLeavesOfType("canvas").includes(this.target) ? this.target : null;
    }
    const next = (leaf?.view as AnyObj)?.getViewType?.() === "canvas" ? leaf : null;
    // A tab can switch to another canvas file, so the file counts too.
    const path = ((next?.view as AnyObj)?.file as TFile | undefined)?.path ?? null;
    if (next === this.target && path === this.targetPath && (next === null || this.unhook)) return;

    this.unhook?.();
    this.unhook = null;
    this.target = next;
    this.targetPath = path;
    this.dirty = false;
    this.hasError = false;
    this.lastGenerated = null;
    this.applySoon.cancel();

    const view = next?.view as AnyObj;
    if (view && typeof view.requestSave === "function") {
      // Every change to a canvas ends in a save request, so that's where to listen.
      const original = view.requestSave;
      const own = Object.prototype.hasOwnProperty.call(view, "requestSave");
      const panel = this;
      const hooked = function (this: AnyObj, ...args: any[]) {
        const out = original.apply(this, args);
        panel.refreshSoon();
        return out;
      };
      view.requestSave = hooked;
      this.unhook = () => {
        if (view.requestSave !== hooked) return;
        if (own) view.requestSave = original;
        else delete view.requestSave;
      };
    }

    this.refreshFromCanvas(true);
  }

  private setStatus(kind: Status, text: string, showButton = false) {
    this.statusEl.dataset.kind = kind;
    this.statusTextEl.setText(text);
    this.statusButtonEl.toggle(showButton);
  }

  private setText(code: string) {
    if (this.input.value !== code) {
      const focused = document.activeElement === this.input;
      const at = this.input.selectionStart;
      this.input.value = code;
      if (focused) this.input.setSelectionRange(Math.min(at, code.length), Math.min(at, code.length));
    }
    this.dirty = false;
    this.hasError = false;
  }

  /** Regenerate the code from the canvas. `force` rewrites it even if nothing the code shows has changed. */
  private refreshFromCanvas(force = false, keepStatus = false) {
    if (!this.input) return;
    const canvas = this.targetCanvas();
    this.emptyEl.toggle(!canvas);
    this.bodyEl.toggle(!!canvas);
    if (!canvas) return;

    this.fileNameEl.setText(this.targetFile()?.basename ?? "");
    this.input.readOnly = !!canvas.readonly;

    let code: string;
    try {
      code = canvasToMermaid(canvas.getData(), { names: this.namesFor() }).code;
    } catch (err) {
      console.error("[CanvasFlow] Couldn't write the canvas as Mermaid", err);
      this.setStatus("error", "Couldn't write this canvas as Mermaid code");
      return;
    }
    if (!force && code === this.lastGenerated) return;
    this.lastGenerated = code;

    // Don't pull the text out from under you while you're typing.
    if (!force && this.dirty && document.activeElement === this.input) {
      this.setStatus("warning", "The canvas changed. Click outside the code to load it.");
      return;
    }
    this.setText(code);
    if (!keepStatus) this.setStatus("muted", canvas.readonly ? "This canvas is read-only" : "In sync with the canvas");
  }

  /** Apply the code to the canvas. Big removals wait for `confirmed`. */
  private applyCode(confirmed: boolean) {
    const canvas = this.targetCanvas();
    if (!canvas || canvas.readonly || typeof canvas.importData !== "function") return;

    let before: AnyObj, result;
    try {
      before = canvas.getData();
      result = syncCanvasFromMermaid(before, this.input.value, {
        names: this.namesFor(),
        center: canvas.posCenter?.() ?? { x: 0, y: 0 },
      });
    } catch (err: any) {
      this.hasError = true;
      const where = typeof err?.line === "number" ? `Line ${err.line}: ` : "";
      this.setStatus("error", where + (err?.message ?? "This code couldn't be read") + ". The canvas hasn't been changed.");
      return;
    }
    this.hasError = false;

    if (!result.changed) {
      this.setStatus("muted", "In sync with the canvas");
      return;
    }

    // Deleting a lot of code deletes a lot of cards, so check that's meant.
    const total = (before.nodes ?? []).length;
    const many = result.removesEverything || (result.cardsRemoved >= 4 && result.cardsRemoved * 2 > total);
    if (many && !confirmed) {
      this.hasError = true;   // keeps the text as typed until this is settled
      this.setStatus("warning", `This would remove ${result.cardsRemoved} of ${total} cards from the canvas.`, true);
      return;
    }

    try {
      canvas.importData(result.data, true);
      canvas.requestSave?.();
      canvas.pushHistory?.(canvas.getData());
      this.lastGenerated = canvasToMermaid(canvas.getData(), { names: this.namesFor() }).code;
    } catch (err) {
      console.error("[CanvasFlow] Couldn't apply Mermaid code to the canvas", err);
      this.setStatus("error", "Couldn't update the canvas");
      return;
    }

    const parts: string[] = [];
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    if (result.cardsAdded) parts.push(`${count(result.cardsAdded, "card", "cards")} added`);
    if (result.cardsRemoved) parts.push(`${count(result.cardsRemoved, "card", "cards")} removed`);
    if (result.linesAdded) parts.push(`${count(result.linesAdded, "line", "lines")} added`);
    if (result.linesRemoved) parts.push(`${count(result.linesRemoved, "line", "lines")} removed`);
    if (result.updated) parts.push(`${result.updated} changed`);
    this.setStatus("ok", `Canvas updated: ${parts.join(", ")}`);

    // If you've already clicked away, show the code as the canvas now has it.
    if (document.activeElement !== this.input) this.refreshFromCanvas(true, true);
  }

  private async copyCode() {
    try {
      await navigator.clipboard.writeText(this.input.value);
      new Notice("Copied Mermaid code");
    } catch {
      new Notice("Couldn't copy to the clipboard");
    }
  }
}
