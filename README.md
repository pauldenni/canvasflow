# CanvasFlow - Obsidian Plugin

CanvasFlow is an experimental Obsidian plugin that adds a focused, vertically scrollable dashboard/navigation mode for Canvas, plus text formatting for Canvas cards.

## Current MVP behavior

- Toggle CanvasFlow on/off.
- Click a Canvas card to focus it.
- Scroll vertically while horizontal movement is locked.
- Reverse vertical scroll direction from settings.
- Press Escape or Backspace to zoom back out one level.
- Click the Canvas background to zoom back out one level.
- Use the floating "Back to canvas" button to return to the previous view.
- Run diagnostics to inspect your local Obsidian Canvas internals.

## Card text formatting

Select a text card and use the extra buttons in its action bar:

- **Align**: left, center or right.
- **Bold** and **Italic**: toggle for the whole card.

Formatting applies to text cards only (not notes, images or links) and works whether or not CanvasFlow mode is on. With several cards selected, it applies to all of the selected text cards. It is saved in the `.canvas` file as a `canvasflowText` field on each card, so it survives reloads, copy/paste and undo. Other apps that open the file ignore the field and show plain text.

You can turn the buttons off in settings under "Card text formatting".

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
- Zoom back out one level
- Show CanvasFlow diagnostics