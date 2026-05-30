# CanvasFlow - Obsidian Plugin

CanvasFlow is an experimental Obsidian plugin that adds a focused, vertically scrollable dashboard/navigation mode for Canvas.

## Current MVP behavior

- Toggle CanvasFlow on/off.
- Click a Canvas card to focus it.
- Scroll vertically while horizontal movement is locked.
- Reverse vertical scroll direction from settings.
- Press Escape or Backspace to zoom back out one level.
- Click the Canvas background to zoom back out one level.
- Use the floating "Back to canvas" button to return to the previous view.
- Run diagnostics to inspect your local Obsidian Canvas internals.

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