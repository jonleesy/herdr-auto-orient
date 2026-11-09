// Auto orient: the panes of a tab follow the shape of the Herdr window.
// When the window changes from wide to tall (for example when you move it to a vertical monitor), the panes
// of each tab stack top to bottom, the next time you look at that tab. From tall to wide, they go side by side.
// It changes only a tab whose panes are all in one line (one row or one column). It does nothing when it starts,
// and nothing to a tab that you make or arrange after the change: only a change of window shape starts it again.
// It moves the terminals with Herdr's own commands (terminal.park, then terminal.keep): the programs keep running.
//
// Keys (keys.json): "auto-orient.toggle" turns it on and off, "auto-orient.fit" fits the shown tab now.
// Herdr gives a mod no window size, so it reads the window bounds from Herdr's window.json ([x, y, width, height]).
import { View, div } from "gpui-kit";
import { appHome, readTextFile, focused, panes, spaces, hc, run, notify, nextCommand } from "herdr";

const RATIO = 1.15; // the window is tall (or wide) when one side is this many times longer than the other
const SETTLE = 1500; // ms that the shape must stay the same before panes move (the window can be moving)
const CELL = 2.4; // a terminal cell is about this many times taller than wide (1.9 to 2.9 with usual fonts and line heights)
const WAIT = 5000; // ms to wait for Herdr to take a terminal out of its tab
const KEEP_WAIT = 1500; // ms to wait for one attempt to put a terminal back
const KEEP_TRIES = 4;

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default class AutoOrient extends View {
  init(_props, cx) {
    this.on = load("on", true);
    this.shape = load("shape", null); // the last window shape the mod acted on: "tall", "wide", or null before the first read
    this.pending = new Set(load("pending", [])); // tabs to fit the next time they show
    this.busy = false;
    this.seen = null; // the last shape read
    this.seenAt = 0; // since when
    this.aspect = 1; // window width / height
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(1000);
        try { await this.tick(cx); } catch (e) { console.log(`auto-orient: ${e?.message ?? e}`); }
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).split(/[.:]/).pop();
        try { await this.command(c, cx); } catch (e) { console.log(`auto-orient: ${e?.message ?? e}`); }
      }
    });
  }

  render() {
    return div(); // nothing to draw
  }

  remember() {
    save("shape", this.shape);
    save("pending", [...this.pending]);
  }

  async read() {
    try {
      const w = JSON.parse(await readTextFile(`${appHome()}/window.json`));
      const [, , width, height] = w.bounds ?? [];
      if (!(width > 0 && height > 0)) return null;
      this.aspect = width / height;
      if (height >= width * RATIO) return "tall";
      if (width >= height * RATIO) return "wide";
      return null; // about square: no direction
    } catch {
      return null;
    }
  }

  async tick(cx) {
    if (!this.on || this.busy) return;
    const shape = await this.read();
    const now = Date.now();
    if (shape !== this.seen) { this.seen = shape; this.seenAt = now; return; }
    if (!shape || now - this.seenAt < SETTLE) return;
    if (this.shape === null) { this.shape = shape; this.remember(); return; } // first start: only learn the shape
    if (shape !== this.shape) {
      // The window changed shape: fit every tab that exists now, each one when it shows.
      this.shape = shape;
      this.pending = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
      this.remember();
    }
    const tab = focused()?.tab;
    if (tab && this.pending.has(tab)) await this.fit(cx, tab, shape, false);
  }

  async command(c, cx) {
    if (c === "toggle") {
      this.on = !this.on;
      save("on", this.on);
      if (this.on) { this.shape = null; this.pending.clear(); this.remember(); } // start again from the shape the window has now
      notify({ title: this.on ? "Auto orient is on" : "Auto orient is off", body: this.on ? "When the window changes shape, the panes of each tab follow it." : "The panes stay as they are.", level: "info", timeout: 3000 });
    } else if (c === "fit") {
      const shape = await this.read();
      const tab = focused()?.tab;
      if (!shape) { notify({ title: "Auto orient", body: "The window is about square, so there is no direction to fit.", level: "info", timeout: 3000 }); return; }
      if (tab && !this.busy) await this.fit(cx, tab, shape, true);
    }
  }

  async fit(cx, tab, shape, manual) {
    this.busy = true;
    try {
      const note = await this.arrange(cx, tab, shape);
      this.pending.delete(tab);
      const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
      for (const id of this.pending) if (!live.has(id)) this.pending.delete(id);
      this.remember();
      if (note && (manual || note.moved)) notify({ title: "Auto orient", body: note.text, level: note.error ? "error" : "info", timeout: note.error ? 8000 : 3000 });
    } finally {
      this.busy = false;
    }
  }

  // Returns null when there is nothing to tell, else { text, moved, error }.
  async arrange(cx, tab, shape) {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === tab));
    if (space?.machine) return { text: "This tab is on another machine. Auto orient changes only tabs on this computer." };
    const list = panes().filter((p) => p.tab === tab);
    if (list.length < 2) return { text: "This tab has only one pane." };
    if (list.some((p) => p.zoomed)) return { text: "A pane in this tab is zoomed. Unzoom it first." };
    if (list.some((p) => !p.terminal || p.terminal.includes("/"))) return { text: "This tab has a mod pane. Auto orient moves only terminals." };

    const sizes = [];
    for (const p of list) {
      const info = await this.get(p.terminal);
      if (!info?.cols || !info?.rows) return { text: "Herdr did not give the size of a terminal." };
      sizes.push({ cols: info.cols, rows: info.rows });
    }
    const line = this.line(sizes);
    const want = shape === "tall" ? "column" : "row";
    if (!line) return { text: "The panes of this tab are not in one line, so auto orient leaves them as they are." };
    if (line === want) return null;

    // Move every pane after the first: take it out of the tab, then put it back in the new direction.
    const keepFocus = focused()?.terminal;
    const [first, ...rest] = list.map((p) => p.terminal);
    const place = want === "row" ? "right" : "down";
    const back = want === "row" ? "down" : "right";
    for (const t of rest) run("terminal.park", { terminal: t });
    // Out means: herdr-core took the tab label away AND the window no longer lists the terminal.
    // Before both, terminal.keep fails with "no running terminal".
    const out = async (t) => !panes().some((p) => p.terminal === t) && !(await this.get(t))?.labels?.["herdr.tab"];
    const allOut = await this.until(cx, async () => (await Promise.all(rest.map(out))).every(Boolean), WAIT);
    let last = first;
    for (const t of rest) {
      if (allOut || (await out(t))) {
        if (!(await this.keep(cx, t, tab, last, allOut ? place : back))) {
          run("terminal.keep", { terminal: t, place: "tab" });
          return { text: `Herdr did not put terminal ${t} back in this tab. It is in a new tab of its own, and it still runs.`, moved: true, error: true };
        }
        last = t;
      }
    }
    if (keepFocus) run("pane.focus", { terminal: keepFocus });
    if (!allOut) return { text: "Herdr did not take the panes out in time. They are back in their old direction.", moved: true, error: true };
    return { text: want === "column" ? "The window is tall, so the panes of this tab now stack." : "The window is wide, so the panes of this tab are now side by side.", moved: true };
  }

  // Puts terminal t back in the tab, next to terminal `after`. Tries again when an attempt does not take.
  async keep(cx, t, tab, after, place) {
    for (let i = 0; i < KEEP_TRIES; i++) {
      run("pane.focus", { terminal: after });
      run("terminal.keep", { terminal: t, place });
      if (await this.until(cx, async () => panes().some((p) => p.terminal === t && p.tab === tab), KEEP_WAIT)) return true;
    }
    return false;
  }

  // "row" when the panes sit side by side, "column" when they stack, null for any other arrangement.
  // Panes in one row all have the same height (rows); panes in one column all have the same width (cols).
  // The shape of each pane, against the shape of the window, tells a row from a column and from a grid.
  line(sizes) {
    const sameRows = sizes.every((s) => s.rows === sizes[0].rows);
    const sameCols = sizes.every((s) => s.cols === sizes[0].cols);
    const r = sizes.reduce((sum, s) => sum + Math.log(s.cols / s.rows / CELL / this.aspect), 0) / sizes.length;
    // Two panes in a row give r near -0.7, in a column near +0.7. The sidebar moves r down by up to 0.25,
    // and a font with another cell shape moves it by up to 0.25 in either direction.
    if (sameRows && r < -0.45) return "row";
    if (sameCols && r > 0.12) return "column";
    return null;
  }

  async get(terminal) {
    try { const r = await hc(["get", terminal, "--json"]); return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
  }

  async until(cx, test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return true;
      await cx.sleep(150);
    }
    return false;
  }
}
