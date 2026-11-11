# CanvasFlow - Obsidian Plugin

CanvasFlow is an experimental Obsidian plugin for Canvas. It adds a focus mode that glides between cards and centers the one you click, plus shapes, card formatting (align, bold and italic), card locking, and line styles (dashed, dotted, thickness, straight and elbow lines).

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

Click the **Add shape** button in the bar at the bottom of the canvas, next to the add card, note and media buttons, then pick one of 16 shapes:

rectangle, circle, diamond, triangle, rounded rectangle, cloud, star, arrow, parallelogram, hexagon, octagon, double arrow, speech bubble, cylinder, predefined process and brace note.

Click a shape to add it in the middle of the view, or drag it to where you want it. Then type its label, just like a standard card. Labels are centered unless you change the alignment, stay inside the shape (also while you type) and the outline redraws to fit when you resize it.

A shape is a text card underneath, so labels, colors, formatting, locking, connections and CanvasFlow focus all work as usual. To change a card's shape, or turn it back into a standard card, select it and use the **Shape** button in its action bar. The shape is saved in the `.canvas` file (`canvasflowShape`); other apps show a plain text card.

## Line styles

Select one or more lines and use the **Line style** button in the action bar to choose:

- **Style**: solid, dashed or dotted.
- **Thickness**: thin, medium (Obsidian's default), thick or extra thick. Arrowheads grow with thicker lines.

The button in the bar at the bottom of the canvas switches every line on that canvas between **curved** (Obsidian's default), **straight** and **elbow** (right-angled) lines.

Line styles are saved on each line, and the line shape is saved with the canvas, all in the `.canvas` file. Undo works as usual. Without CanvasFlow, Obsidian shows the lines as plain curves.

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

## Commands

- Toggle CanvasFlow Mode
- Focus selected Canvas card
- Back to canvas (exit focus)
- Show CanvasFlow diagnostics