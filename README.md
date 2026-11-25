# CanvasFlow - Obsidian Plugin

CanvasFlow is an experimental Obsidian plugin for Canvas. It adds a focus mode that glides between cards and centers the one you click, plus shapes, card formatting (align, bold and italic), card locking, line styles (dashed, dotted, thickness, straight and elbow lines), line labels you can move, with more than one per line, and Mermaid support: copy a canvas as a Mermaid flowchart, or add a Mermaid flowchart to a canvas.

## CanvasFlow mode

- Toggle CanvasFlow mode with the ribbon icon or the "Toggle CanvasFlow Mode" command.
- Click a card to zoom in and center it, from any zoom level. Set how much of the screen it fills under "Focused card size" in settings.
- Pan and zoom the canvas freely, the same as outside CanvasFlow mode. Dragging a card doesn't focus it.
- Click another card to glide to it. Press Escape, or use the floating "Back to canvas" button, to leave focus and zoom out to show every card. CanvasFlow mode stays on. Clicking the blank canvas does nothing. Delete or Backspace deletes the selected card as usual, and you stay where you are.
- Run "Show CanvasFlow diagnostics" to inspect your local Obsidian Canvas internals.

## Card text formatting

Select a text card and use the extra buttons in its action bar:

- **Align**: left, center or right.
- **Bold** and **Italic**: toggle for the whole card.

Formatting applies to text cards only (not notes, images or links) and works whether or not CanvasFlow mode is on. With several cards selected, it applies to all of the selected text cards. It is saved in the `.canvas` file as a `canvasflowText` field on each card, so it survives reloads, copy/paste and undo. Other apps that open the file ignore the field and show plain text.

You can turn the buttons off in settings under "Card text formatting".

## Shapes

Click the **Add shape** button in the bar at the bottom of the canvas, next to the add card, note and media buttons, then pick one of 28 shapes:

rectangle, rounded rectangle, circle, diamond, triangle, inverted triangle, parallelogram, trapezoid, hexagon, octagon, star, cloud, arrow, left arrow, double arrow, chevron, pentagon arrow, predefined process, document, documents, cylinder, horizontal cylinder, stored data, display, paper tape, speech bubble, right brace note and left brace note.

Click a shape to add it in the middle of the view, or drag it to where you want it. Then type its label, just like a standard card. Labels are centered unless you change the alignment, stay inside the shape (also while you type) and the outline redraws to fit when you resize it.

A shape is a text card underneath, so labels, colors, formatting, locking, connections and CanvasFlow focus all work as usual. To change a card's shape, or turn it back into a standard card, select it and use the **Shape** button in its action bar. The shape is saved in the `.canvas` file (`canvasflowShape`); other apps show a plain text card.

The **Outline style** button sets a shape's outline to solid, dashed or dotted, and thin (the default, like a card border), medium, thick or extra thick. Thicker outlines stay inside the card, and corners still match a card's. Saved as `canvasflowShapeLine`.

## Line styles

Select one or more lines and use the **Line style** button in the action bar to choose:

- **Style**: solid, dashed or dotted.
- **Thickness**: thin, medium (Obsidian's default), thick or extra thick. Arrowheads grow with thicker lines.

The button in the bar at the bottom of the canvas switches every line on that canvas between **curved** (Obsidian's default), **straight** and **elbow** (right-angled) lines.

On an elbow line that joins two left or right sides, or two top or bottom sides, drag the middle stretch to move where the line bends. The ends stay on the middle of their sides, and the bend snaps to halfway when you get close. Lines that turn only once (out of a side and into a top, say) have no middle stretch to move.

Line styles and bends are saved on each line, and the line shape is saved with the canvas, all in the `.canvas` file. Undo works as usual. Without CanvasFlow, Obsidian shows the lines as plain curves.

## Line labels

- **Add**: double-click a line where you want a label, type the text and click away. Do it again for another label; a line can have as many as you like. A single click only selects the line.
- **Move**: drag a label anywhere along its line. Pull it off the line and it snaps to sit right next to the line, above, below or beside it; it can't be left further away. Drag it back to put it on the line again. Labels keep their place on the line when cards move.
- **Edit**: with the line selected, click a label. To remove a label, delete its text.

Obsidian keeps line labels a readable size however far you zoom out, which can make them look large next to the cards. Turn off **Keep line labels readable when zoomed out** in settings and they shrink and grow like the text on cards, and hide once you zoom out far enough that cards show placeholders.

A line's first label is Obsidian's own, so other apps show it (in the middle of the line). Its position is saved as `canvasflowLabelPos` and further labels as `canvasflowLabels`, on the line in the `.canvas` file. Undo works as usual.

## Copy as Mermaid

Turn a canvas into a [Mermaid](https://mermaid.js.org) flowchart you can paste into a note, GitHub or mermaid.live. Open the command palette and run:

- **Copy canvas as Mermaid**: the flowchart code on its own.
- **Copy canvas as Mermaid code block (for notes)**: the same, wrapped in a `mermaid` code block, ready to paste into a note.

With cards selected, only those cards and the lines between them are copied. Otherwise the whole canvas is.

What carries over:

- **Cards**: text cards with their text, notes with their file name, links with their address.
- **Shapes**: rectangle, rounded rectangle, circle, diamond, triangle, inverted triangle, parallelogram, trapezoid, hexagon, predefined process, document, documents, both cylinders, stored data, display, paper tape and both brace notes. Shapes Mermaid has no match for (star, cloud, the arrows, octagon, speech bubble) become rectangles.
- **Groups**: as subgraphs, with the cards inside them.
- **Lines**: arrowheads at either end, dashed or dotted lines (Mermaid has one dotted style for both), and thick or extra thick lines. A line's labels are stacked into one label.
- **Colors**: card, group and line colors, and a shape's outline style and thickness.
- **Direction**: top-down, left-to-right and so on, picked from the way most lines run.

Mermaid lays the chart out itself, so positions, sizes, line bends and where labels sit are left out. Triangle, document, sideways cylinder, stored data, display, paper tape and brace shapes need Mermaid 11.3 or later.

## Add a Mermaid flowchart

Turn Mermaid flowchart code into shapes, groups and lines on the canvas that you can then move and edit like any others.

Open the command palette and run **Add Mermaid flowchart to canvas**. Paste or type the code in the box (it starts with what's on your clipboard, if that's a flowchart) and click **Add to canvas**, or press Cmd/Ctrl+Enter. A pasted `mermaid` code block from a note works as it is.

The chart is laid out for you, in the direction the code asks for (`TD`, `LR` and so on), and added in the middle of the view. If that would put it on top of cards you already have, it goes to the right of them. The new cards are selected, so you can drag the whole chart somewhere else straight away.

What carries over:

- **Nodes**: as shapes, with their text. Mermaid's shapes map onto the matching CanvasFlow shape; ones with no match become rectangles.
- **Subgraphs**: as groups, including subgraphs inside subgraphs.
- **Lines**: arrowheads, dotted and thick lines, and labels. A line that runs back against the chart's direction loops round the side.
- **Colors and outlines**: from `style`, `classDef`, `class`, `:::` and `linkStyle`. Stroke color (or fill, when there's no stroke) becomes the card or line color.

Only flowcharts (`flowchart` or `graph`) can be added; sequence diagrams and other chart types can't. If the code can't be read, the box stays open and says which line is wrong. `click` actions, icons and Mermaid's circle and cross line ends aren't supported: circle and cross ends become arrows.

## Locking cards

Select any card (text, note, image, link or group) and click the lock button in its action bar. A locked card:

- can't be moved, resized or deleted, including by arrow keys, Cut or the Delete key
- still lets you edit its text
- has a slightly heavier bottom edge (shapes get a slightly heavier outline), so you can tell at a glance which cards are locked
- turns red instead of the accent color when selected, so a box selection shows which cards won't move

Dragging a selection that includes locked cards moves only the unlocked ones. Click the lock button again to unlock. Undo and redo work as usual. Like formatting, the lock is saved in the `.canvas` file (`canvasflowLocked`).

## Install for local testing

1. Place the `canvasflow` folder here:

   `.obsidian/plugins/canvasflow/`

2. From that folder, run:

   `npm install`

   `npm run build`

3. Restart Obsidian or reload the plugin.

If you keep the code somewhere else, the build can copy the plugin into your vault for you. Create a file called `.vault-plugin-dir` next to `package.json` with one line, the full path to your vault's `.obsidian/plugins/canvasflow` folder. Every `npm run build` (and every rebuild under `npm run dev`) then copies `main.js`, `manifest.json` and `styles.css` there. The file is not committed, so each computer has its own.

## Commands

- Toggle CanvasFlow Mode
- Focus selected Canvas card
- Back to canvas (exit focus)
- Show CanvasFlow diagnostics
- Copy canvas as Mermaid
- Copy canvas as Mermaid code block (for notes)
- Add Mermaid flowchart to canvas