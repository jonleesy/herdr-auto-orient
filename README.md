# Auto orient for Herdr

A mod for the [Herdr](https://herdr.dev) app. The panes of a tab follow the shape of the window. Move the window to a vertical monitor, and the panes stack top to bottom. Move it back to a wide monitor, and they sit side by side again. The programs in the panes keep running.

**Status: experimental, version 0.1.0.** It is tested on one Mac with Herdr 0.1.14, with tabs of two and three panes, in both directions. It is not tested on Linux or Windows. Read "Keyboard focus" and "If Herdr stops during a move" before you use it.

![Auto orient](preview.png)

## Install

Ask your agent in Herdr:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/jonleesy/herdr-auto-orient
```

Or by hand:

1. Copy `mods/auto-orient/` to `~/.config/herdr-app/mods/`.
2. Add a floating block to your own layout (clone a shipped one first with `layout.clone`): `{ "id": "auto-orient", "content": { "mod": "auto-orient" }, "edge": "left", "align": "start" }`.
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`.
4. Run `herdr-app check ~/.config/herdr-app/mods/auto-orient`.

## Keys

| Key | What it does |
|---|---|
| `cmd-alt-o` | Turns auto orient on and off. |
| `cmd-alt-shift-o` | Fits the shown tab to the window now. |

## What it changes

- Only a tab whose panes are all in one row or one column. A grid stays as it is.
- Only after the window changes shape (tall or wide). It does nothing when it starts, and nothing to a tab that you arrange after the change.
- Each tab one time for each change, when you look at it.
- A tab with two panes changes by itself. A tab with three or more panes changes only when you press `cmd-alt-shift-o`. A toast tells you when such a tab waits.

It uses Herdr's own commands (`terminal.park`, `terminal.keep` and `pane.swap`). It runs `hc get` to read terminal sizes, and it reads Herdr's `window.json` for the window size. It uses no network and writes no files. `RECIPE.md` has the full details.

## Keyboard focus

Herdr has no command that turns a split, so the mod takes a pane out of the tab and puts it back in the new direction. While a pane is out, Herdr gives the keyboard focus to another pane.

- Two panes: the mod moves the pane that you type in. The other pane has the focus for about 0.03 s (measured). Then the focus is back on your pane.
- Three or more panes: the move gives the focus to each pane in turn for a moment. That is why it happens only when you press the key.

A key that you press in that short time goes to the other pane. Do not type while you move the window between monitors.

## If Herdr stops during a move

A move takes less than one second. If Herdr quits or crashes in that time, a terminal can keep running without a pane. Find it with `hc ls`, then give it a pane again with `herdr-app do terminal.keep --terminal <address>`.

## License

MIT. See `LICENSE`.
