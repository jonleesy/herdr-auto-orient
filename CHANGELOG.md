# Changelog

## 0.1.0 (2026-11-09)

First release. Experimental.

- The panes of a tab follow the shape of the window: stacked in a tall window, side by side in a wide window.
- Only tabs whose panes are in one line, only after a change of window shape, each tab one time when it shows.
- Keyboard focus: a tab with two panes moves the pane that you type in, so the other pane has the focus for about 0.03 s (the first build: about 0.3 s). A tab with three or more panes moves only on `cmd-alt-shift-o`.
- `terminal.keep` waits until the window and herdr-core both release a parked terminal, and tries again up to 4 times.
- Nothing moves when the mod starts.
- Keys: `cmd-alt-o` (on and off), `cmd-alt-shift-o` (fit the shown tab now).
