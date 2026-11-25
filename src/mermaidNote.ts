/**
 * Edit a note's Mermaid flowchart as a canvas.
 *
 * Running "Edit Mermaid block as a canvas" on a `mermaid` block makes a canvas
 * file for it next to the note and opens the canvas beside the note. From then
 * on the two are kept in step through their saved files:
 *
 * - Change the canvas and the block in the note is rewritten from it.
 * - Change the block's code in the note and the canvas is updated as a diff,
 *   so cards keep their place.
 *
 * The block and the canvas find each other by a short link id: a comment line
 * in the block and a field in the canvas file (see mermaidBlocks.ts).
 */

import { MarkdownView, Notice, Plugin, TFile, normalizePath, setIcon, setTooltip } from "obsidian";
import { MermaidBlock, blockAtLine, findMermaidBlocks, newLinkId, writeBlock } from "./mermaidBlocks";
import { canvasToMermaid } from "./mermaidExport";
import { mermaidToCanvas } from "./mermaidImport";
import { parseFlowchart } from "./mermaidParse";
import { syncCanvasFromMermaid } from "./mermaidSync";

type AnyObj = any;

/** Field in the canvas file: `{ id, note }`, the link id and the path of the note the chart lives in. */
const LINK_KEY = "canvasflowMermaidLink";
const BUTTON_CLASS = "canvasflow-mermaid-edit";
/** More automatic writes than this for one chart in ten seconds means the two sides disagree; stop rather than loop. */
const MAX_WRITES = 6;
const WRITES_WINDOW_MS = 10_000;

export class MermaidNoteEditor {
  /** Where each link's canvas and note were last seen, so they aren't searched for on every save. */
  private canvasPaths = new Map<string, string>();
  private notePaths = new Map<string, string>();
  private writes = new Map<string, number[]>();
  private stopped = new Set<string>();

  constructor(private plugin: Plugin) {}

  load() {
    const { plugin } = this;
    const { vault } = plugin.app;

    plugin.addCommand({
      id: "edit-mermaid-block",
      name: "Edit Mermaid block as a canvas",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        const line = editor.getCursor().line;
        if (!file || !blockAtLine(findMermaidBlocks(editor.getValue()), line)) return false;
        if (!checking) void this.editFromEditor(ctx as MarkdownView, file, line);
        return true;
      },
    });

    plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
      const file = info.file;
      const line = editor.getCursor().line;
      if (!file || !blockAtLine(findMermaidBlocks(editor.getValue()), line)) return;
      menu.addItem(item => item
        .setTitle("Edit Mermaid block as a canvas")
        .setIcon("workflow")
        .onClick(() => void this.editFromEditor(info as MarkdownView, file, line)));
    }));

    // Live preview only, like Obsidian's own "edit this block" button: reading
    // view has neither. Live preview draws Mermaid without post processors, so
    // the button is added when the pointer first moves over the chart.
    plugin.registerDomEvent(document, "mouseover", evt => this.addLivePreviewButton(evt));

    plugin.registerEvent(vault.on("modify", file => {
      if (!(file instanceof TFile)) return;
      if (file.extension === "canvas") void this.canvasChanged(file).catch(err => console.error("[CanvasFlow] Mermaid note link", err));
      else if (file.extension === "md") void this.noteChanged(file).catch(err => console.error("[CanvasFlow] Mermaid note link", err));
    }));
  }

  /** The hover button on a drawn chart. Shown by styles.css while the pointer is over `host`. */
  private makeButton(host: HTMLElement, onClick: () => void): HTMLElement {
    host.addClass("canvasflow-mermaid-block");
    const button = host.createDiv({ cls: `clickable-icon ${BUTTON_CLASS}` });
    setIcon(button, "layout-dashboard");
    button.setAttribute("aria-label", "Edit as a canvas");
    setTooltip(button, "Edit as a canvas");
    // Keep the click from reaching the editor, which would open the block's code.
    button.addEventListener("mousedown", evt => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    button.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      onClick();
    });
    return button;
  }

  /** Live preview: add the button beside Obsidian's own "edit this block" button the first time the chart is hovered. */
  private addLivePreviewButton(evt: MouseEvent) {
    const target = evt.target as HTMLElement | null;
    const block = target?.closest?.<HTMLElement>(".cm-preview-code-block.cm-lang-mermaid");
    if (!block || block.querySelector(`.${BUTTON_CLASS}`)) return;

    const button = this.makeButton(block, () => {
      const view = this.plugin.app.workspace.getLeavesOfType("markdown")
        .map(leaf => leaf.view as MarkdownView)
        .find(v => v?.contentEl?.contains(block));
      const file = view?.file;
      const cm = (view?.editor as AnyObj)?.cm;
      if (!view || !file || typeof cm?.posAtDOM !== "function") {
        new Notice('Click inside the Mermaid code, then run "Edit Mermaid block as a canvas" from the command palette');
        return;
      }
      const line = view.editor.offsetToPos(cm.posAtDOM(block)).line;
      void this.editFromEditor(view, file, line);
    });

    // Sit just left of Obsidian's button, at the same height.
    const native = block.querySelector<HTMLElement>(".edit-block-button");
    if (native) {
      const blockRect = block.getBoundingClientRect();
      const rect = native.getBoundingClientRect();
      if (rect.width > 0) {
        button.style.top = `${rect.top - blockRect.top}px`;
        button.style.right = `${blockRect.right - rect.left + 2}px`;
      }
    }
  }

  private async editFromEditor(view: MarkdownView, file: TFile, line: number) {
    // The file on disk can be a couple of seconds behind what's typed.
    try { await view.save?.(); } catch {}
    await this.edit(file, line, line);
  }

  /** Open the Mermaid block at `line` of `file` as a canvas, making the canvas the first time. */
  private async edit(file: TFile, line: number, through: number) {
    const { vault, workspace } = this.plugin.app;
    try {
      const text = await vault.read(file);
      const block = blockAtLine(findMermaidBlocks(text), line, through);
      if (!block) {
        new Notice("Couldn't find the Mermaid block in the note");
        return;
      }
      try {
        parseFlowchart(block.code);
      } catch (err: any) {
        const where = typeof err?.line === "number" ? ` (line ${err.line} of the block)` : "";
        new Notice(`${err?.message ?? "This Mermaid code couldn't be read"}${where}`, 8000);
        return;
      }

      const id = block.linkId ?? newLinkId();
      let canvasFile = block.linkId ? await this.findCanvas(block.linkId) : null;

      if (canvasFile) {
        // Bring the canvas up to date with the code in the note. Cards keep their place.
        const data = this.readCanvas(await vault.read(canvasFile));
        if (data) {
          const result = syncCanvasFromMermaid(data, block.code);
          const link = data[LINK_KEY] ?? {};
          if (result.changed || link.note !== file.path) {
            const next = { ...result.data, [LINK_KEY]: { id, note: file.path } };
            await vault.modify(canvasFile, JSON.stringify(next, null, "\t"));
          }
        }
      } else {
        const chart = mermaidToCanvas(block.code, { x: 0, y: 0 });
        const data = { nodes: chart.nodes, edges: chart.edges, [LINK_KEY]: { id, note: file.path } };
        canvasFile = await vault.create(this.newCanvasPath(file), JSON.stringify(data, null, "\t"));
        if (!block.linkId) {
          // Add the link line; the code itself stays as written until the canvas changes.
          await vault.process(file, current => {
            const now = blockAtLine(findMermaidBlocks(current), block.start, block.end);
            return now && !now.linkId ? writeBlock(current, now, now.code, id) : current;
          });
        }
      }
      this.canvasPaths.set(id, canvasFile.path);
      this.notePaths.set(id, file.path);
      this.stopped.delete(id);

      const open = workspace.getLeavesOfType("canvas").find(leaf => (leaf.view as AnyObj)?.file === canvasFile);
      const leaf = open ?? workspace.getLeaf("split", "vertical");
      if (!open) await leaf.openFile(canvasFile);
      workspace.revealLeaf(leaf);
      window.setTimeout(() => {
        try { (leaf.view as AnyObj)?.canvas?.zoomToFit?.(); } catch {}
      }, 100);
      new Notice(`Editing the flowchart from "${file.basename}". Changes to the canvas are saved back to the note.`, 6000);
    } catch (err) {
      console.error("[CanvasFlow] Edit Mermaid block as a canvas", err);
      new Notice("Couldn't open the Mermaid block as a canvas");
    }
  }

  private newCanvasPath(note: TFile): string {
    const { vault } = this.plugin.app;
    const folder = note.parent && note.parent.path !== "/" ? `${note.parent.path}/` : "";
    for (let n = 1; ; n++) {
      const path = normalizePath(`${folder}${note.basename} flowchart${n > 1 ? ` ${n}` : ""}.canvas`);
      if (!vault.getAbstractFileByPath(path)) return path;
    }
  }

  private readCanvas(text: string): AnyObj | null {
    try {
      const data = JSON.parse(text || "{}");
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  }

  /** The canvas file carrying this link id. */
  private async findCanvas(id: string): Promise<TFile | null> {
    const { vault } = this.plugin.app;
    const check = async (file: unknown): Promise<TFile | null> => {
      if (!(file instanceof TFile) || file.extension !== "canvas") return null;
      const text = await vault.cachedRead(file);
      if (!text.includes(id)) return null;
      return this.readCanvas(text)?.[LINK_KEY]?.id === id ? file : null;
    };
    const known = await check(vault.getAbstractFileByPath(this.canvasPaths.get(id) ?? ""));
    if (known) return known;
    for (const file of vault.getFiles()) {
      const found = await check(file);
      if (found) { this.canvasPaths.set(id, found.path); return found; }
    }
    return null;
  }

  /** The note holding the block with this link id, and the block. `hint` is the path the canvas remembers. */
  private async findBlock(id: string, hint?: string): Promise<{ file: TFile; text: string; block: MermaidBlock } | null> {
    const { vault } = this.plugin.app;
    const check = async (file: unknown) => {
      if (!(file instanceof TFile) || file.extension !== "md") return null;
      const text = await vault.cachedRead(file);
      if (!text.includes(id)) return null;
      const block = findMermaidBlocks(text).find(b => b.linkId === id);
      return block ? { file, text, block } : null;
    };
    for (const path of [this.notePaths.get(id), hint]) {
      const found = path ? await check(vault.getAbstractFileByPath(path)) : null;
      if (found) { this.notePaths.set(id, found.file.path); return found; }
    }
    // The note was renamed or moved: look for the link line.
    for (const file of vault.getMarkdownFiles()) {
      const found = await check(file);
      if (found) { this.notePaths.set(id, found.file.path); return found; }
    }
    return null;
  }

  /** True when it's fine to write for this link again; false once the two sides have gone back and forth too often. */
  private mayWrite(id: string, noteName: string): boolean {
    if (this.stopped.has(id)) return false;
    const now = Date.now();
    const recent = (this.writes.get(id) ?? []).filter(t => now - t < WRITES_WINDOW_MS);
    recent.push(now);
    this.writes.set(id, recent);
    if (recent.length <= MAX_WRITES) return true;
    this.stopped.add(id);
    new Notice(`CanvasFlow stopped updating the flowchart in "${noteName}" because the note and the canvas kept changing each other. Run "Edit Mermaid block as a canvas" on it to start again.`, 10000);
    return false;
  }

  /** A linked canvas was saved: rewrite its block in the note, if the block doesn't already say the same. */
  private async canvasChanged(file: TFile) {
    const { vault } = this.plugin.app;
    const text = await vault.cachedRead(file);
    if (!text.includes(LINK_KEY)) return;
    const data = this.readCanvas(text);
    const link = data?.[LINK_KEY];
    if (!data || typeof link?.id !== "string") return;
    const id: string = link.id;
    this.canvasPaths.set(id, file.path);

    const found = await this.findBlock(id, link.note);
    if (!found) return;
    try {
      if (!syncCanvasFromMermaid(data, found.block.code).changed) return;
    } catch {
      // The block's code can't be read; the canvas is the good copy.
    }
    if (!this.mayWrite(id, found.file.basename)) return;

    const code = canvasToMermaid(data).code;
    await vault.process(found.file, current => {
      const block = findMermaidBlocks(current).find(b => b.linkId === id);
      return block ? writeBlock(current, block, code, id) : current;
    });
  }

  /** A note was saved: bring the canvases of its linked blocks up to date with their code. */
  private async noteChanged(file: TFile) {
    const { vault } = this.plugin.app;
    const text = await vault.cachedRead(file);
    if (!/canvasflow\s+link/i.test(text)) return;

    for (const block of findMermaidBlocks(text)) {
      const id = block.linkId;
      if (!id) continue;
      this.notePaths.set(id, file.path);
      const canvasFile = await this.findCanvas(id);
      if (!canvasFile) continue;
      const data = this.readCanvas(await vault.cachedRead(canvasFile));
      if (!data) continue;

      let result;
      try {
        result = syncCanvasFromMermaid(data, block.code);
      } catch {
        continue;   // half-typed code: wait for it to make sense
      }
      if (!result.changed) continue;
      // Deleting most of the code while rewriting it shouldn't empty the canvas (and lose its layout).
      const total = (data.nodes ?? []).length;
      if (result.removesEverything || (result.cardsRemoved >= 4 && result.cardsRemoved * 2 > total)) continue;
      if (!this.mayWrite(id, file.basename)) continue;

      const next = { ...result.data, [LINK_KEY]: { id, note: file.path } };
      await vault.modify(canvasFile, JSON.stringify(next, null, "\t"));
    }
  }
}
