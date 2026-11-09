// Auto orient: the panes of a tab follow the shape of the Herdr window.
// When the window changes from wide to tall (for example when you move it to a vertical monitor), the panes
// of each tab stack top to bottom, the next time you look at that tab. From tall to wide, they go side by side.
// It changes only a tab whose panes are all in one line (one row or one column). It does nothing when it starts,
// and nothing to a tab that you make or arrange after the change: only a change of window shape starts it again.
// It moves the terminals with Herdr's own commands (terminal.park, then terminal.keep): the programs keep running.
// Keyboard focus: a tab with two panes moves by itself; the pane that you type in moves, and for about 0.03 s
// the other pane has the focus. A tab with three or more panes moves only on the "fit" key, because its move
// gives the focus to each pane in turn for a moment.
//
// Version 0.1.0. Keys (keys.json): "auto-orient.toggle" turns it on and off, "auto-orient.fit" fits the shown tab now.
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
      const note = await this.arrange(cx, tab, shape, manual);
      this.pending.delete(tab);
      const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
      for (const id of this.pending) if (!live.has(id)) this.pending.delete(id);
      this.remember();
      if (note && (manual || note.moved || note.tell)) notify({ title: "Auto orient", body: note.text, level: note.error ? "error" : "info", timeout: note.error ? 8000 : 3000 });
    } finally {
      this.busy = false;
    }
  }

  // Returns null when there is nothing to tell, else { text, moved, error, tell }.
  async arrange(cx, tab, shape, manual) {
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

    const order = list.map((p) => p.terminal);
    const place = want === "row" ? "right" : "down";
    const done = { text: want === "column" ? "The window is tall, so the panes of this tab now stack." : "The window is wide, so the panes of this tab are now side by side.", moved: true };
    if (order.length === 2) return (await this.moveTwo(cx, tab, order, place)) ?? done;
    // Three or more panes: the move puts the focus on each pane in turn for a moment, so it happens only on the key.
    if (!manual) return { text: "This tab has three or more panes. Press Cmd+Alt+Shift+O to fit it when you are not typing.", tell: true };
    return (await this.moveMany(cx, tab, order, place)) ?? done;
  }

  // Two panes. The pane with the keyboard focus moves, and the other pane stays. While the focused pane is out of
  // the tab, Herdr gives the focus to the other pane, so this part must be short: it polls every 20 ms.
  // terminal.keep puts the pane next to the focused pane (the other one) and gives it the focus again.
  // Measured: the other pane has the focus for about 0.02 s. Returns null when it worked, else a note.
  async moveTwo(cx, tab, order, place) {
    const focusNow = focused()?.terminal;
    const anchor = order.includes(focusNow) ? focusNow : order[1];
    const other = order.find((t) => t !== anchor);
    run("terminal.park", { terminal: anchor });
    if (!(await this.until(cx, () => this.out(anchor), WAIT, 20))) {
      if (!(await this.out(anchor))) return { text: "Herdr did not take the pane out in time. Nothing moved.", error: true };
    }
    if (!(await this.keep(cx, anchor, tab, other, place))) {
      run("terminal.keep", { terminal: anchor, place: "tab" });
      return { text: `Herdr did not put terminal ${anchor} back in this tab. It is in a new tab of its own, and it still runs.`, moved: true, error: true };
    }
    await this.reorder(cx, tab, order);
    if (!(await this.refocus(cx, anchor))) return { text: "The panes moved, but the keyboard focus is not on the pane that had it. Click the pane before you type.", moved: true, error: true };
    return null;
  }

  // Three or more panes (only on the key). The focused pane stays. The others go out, then back directly after it,
  // in reverse order, so the result is the focused pane and then the others in order. pane.swap then restores the
  // old order. A swap does not move the focus. Returns null when it worked, else a note.
  async moveMany(cx, tab, order, place) {
    const focusNow = focused()?.terminal;
    const anchor = order.includes(focusNow) ? focusNow : order[0];
    if (anchor !== focusNow) run("pane.focus", { terminal: anchor });
    const others = order.filter((t) => t !== anchor);
    const back = place === "right" ? "down" : "right";
    for (const t of others) run("terminal.park", { terminal: t });
    const allOut = await this.until(cx, async () => (await Promise.all(others.map((t) => this.out(t)))).every(Boolean), WAIT, 20);
    for (const t of [...others].reverse()) {
      if (!allOut && panes().some((p) => p.terminal === t)) continue; // never left the tab
      if (!(await this.keep(cx, t, tab, anchor, allOut ? place : back))) {
        run("terminal.keep", { terminal: t, place: "tab" });
        await this.refocus(cx, anchor);
        return { text: `Herdr did not put terminal ${t} back in this tab. It is in a new tab of its own, and it still runs.`, moved: true, error: true };
      }
      run("pane.focus", { terminal: anchor }); // terminal.keep gave the focus to the new pane: give it back at once
    }
    await this.reorder(cx, tab, order);
    const focusOk = await this.refocus(cx, anchor);
    if (!allOut) return { text: "Herdr did not take the panes out in time. They are back in their old direction.", moved: true, error: true };
    if (!focusOk) return { text: "The panes moved, but the keyboard focus is not on the pane that had it. Click the pane before you type.", moved: true, error: true };
    return null;
  }

  // Out of its tab means: the window no longer lists the terminal AND herdr-core took its tab label away.
  // Before both, terminal.keep fails with "no running terminal".
  async out(t) {
    return !panes().some((p) => p.terminal === t) && !(await this.get(t))?.labels?.["herdr.tab"];
  }

  // Puts terminal t back in the tab, directly after terminal `after`, which must have the focus.
  // Tries again when an attempt does not take.
  async keep(cx, t, tab, after, place) {
    for (let i = 0; i < KEEP_TRIES; i++) {
      if (focused()?.terminal !== after) run("pane.focus", { terminal: after });
      run("terminal.keep", { terminal: t, place });
      if (await this.until(cx, async () => panes().some((p) => p.terminal === t && p.tab === tab), KEEP_WAIT, 20)) return true;
    }
    return false;
  }

  // Swaps panes until the tab shows the terminals in `order` again. pane.swap moves panes, not the focus.
  async reorder(cx, tab, order) {
    for (let i = 0; i < order.length; i++) {
      const now = panes().filter((p) => p.tab === tab);
      if (now.length !== order.length || now[i]?.terminal === order[i]) continue;
      const target = now.find((p) => p.terminal === order[i]);
      if (!target) continue;
      run("pane.swap", { pane: now[i].pane, target: target.pane });
      await this.until(cx, async () => panes().filter((p) => p.tab === tab)[i]?.terminal === order[i], 1000, 20);
    }
  }

  // Makes sure that the anchor has the keyboard focus. Returns false when it still does not after 3 tries.
  async refocus(cx, anchor) {
    for (let i = 0; i < 3; i++) {
      if (focused()?.terminal === anchor) return true;
      run("pane.focus", { terminal: anchor });
      if (await this.until(cx, async () => focused()?.terminal === anchor, 500, 20)) return true;
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

  async until(cx, test, ms, step = 150) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return true;
      await cx.sleep(step);
    }
    return false;
  }
}
