// Sequencer — a director that scores the show against the bar grid.
//
// Pattern taken from reference/04-cpu-demo.md: a chain of fixed-length scenes,
// each easing a set of parameters from one value to another, with the renderer
// reading the current values and knowing nothing about time. Two changes for
// this project:
//
//   * scenes are measured in BARS, not seconds, so the show follows whatever
//     src/bpm.js has locked onto rather than a fixed clock;
//   * scenes drive LAYERS — several effects held at independent levels at the
//     same time — because the pass chain already composes any number of active
//     effects, so simultaneity costs nothing.
//
// A layer is just a named slot in a scene. Layer 0 tends to hold the surface
// treatment, 1 the motion, 2 the accents, but nothing enforces that; a layer is
// only "which effect am I driving, and between which levels".

// Deterministic hash — NOT Math.random(). The point is that the show varies
// between cycles but replays identically, which a real RNG cannot give you.
// Idea from two references whose directors derive all variation from hashed
// beat indices rather than from authored keyframes.
function hash2(a, b) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// A layer value may be a number (fixed) or [min, max] (hashed per cycle).
function resolve(v, seedA, seedB) {
  return Array.isArray(v) ? v[0] + (v[1] - v[0]) * hash2(seedA, seedB) : v;
}

const EASE = {
  // 0 -> 1 across the scene
  in: (t) => t * t * (3.0 - 2.0 * t),
  // 1 -> 0 across the scene
  out: (t) => 1.0 - t * t * (3.0 - 2.0 * t),
  // flat at the target for the whole scene
  hold: () => 1,
  // 0 -> 1 -> 0 within the scene: a swell that resolves before the next one
  pulse: (t) => Math.sin(Math.PI * t),
  // snap on, decay across the scene — good for accents on a downbeat
  hit: (t) => Math.pow(1.0 - t, 2.2),
};

// The show. Each scene lasts `bars` and holds up to three layers.
// `from`/`to` are effect progress levels; `curve` picks how it gets there.
export const SHOW = [
  {
    name: 'arrive', bars: 4, layers: [
      { fx: 'terminal', from: 0, to: 1, curve: 'in' },
    ],
  },
  {
    name: 'settle', bars: 4, layers: [
      { fx: 'terminal', from: 1, to: 0.30, curve: 'in' },
      { fx: 'ripple', from: 0, to: 0.55, curve: 'pulse' },
    ],
  },
  {
    name: 'sand', bars: 8, layers: [
      { fx: 'dune', from: 0, to: 1, curve: 'in' },
      { fx: 'ripple', from: 0, to: 0.35, curve: 'hold' },
    ],
  },
  {
    name: 'liquefy', bars: 4, layers: [
      { fx: 'dune', from: 1, to: 0.35, curve: 'in' },
      { fx: 'liquid', from: 0, to: 1, curve: 'pulse' },
    ],
  },
  {
    // `fx` as a list picks one per cycle — this scene is "some kind of break",
    // not always the same one. `to` as a range varies the intensity with it.
    name: 'break', bars: 2, layers: [
      { fx: ['shatter', 'explode', 'blowaway'], from: 0, to: [0.75, 1.0], curve: 'pulse' },
      { fx: ['glitch', 'melt'], from: 0, to: [0.6, 0.95], curve: 'hit' },
    ],
  },
  {
    name: 'neon', bars: 8, layers: [
      { fx: 'neon', from: 0, to: 1, curve: 'in' },
      { fx: 'plasma', from: 0, to: 0.5, curve: 'pulse' },
      { fx: 'tiles', from: 0, to: 0.4, curve: 'pulse' },
    ],
  },
  {
    name: 'storm', bars: 4, layers: [
      { fx: 'neon', from: 1, to: 0, curve: 'in' },
      { fx: ['vortex', 'liquid'], from: 0, to: [0.7, 1.0], curve: 'pulse' },
      { fx: ['filament', 'plasma'], from: 0, to: [0.6, 0.9], curve: 'in' },
    ],
  },
  {
    name: 'reset', bars: 2, layers: [
      { fx: 'filament', from: 0.8, to: 0, curve: 'in' },
      { fx: 'glitch', from: 0, to: 1, curve: 'hit' },
    ],
  },
];

export class Sequencer {
  constructor(show = SHOW) {
    this.show = show;
    this.enabled = false;
    this.bar = 0;
    this.levels = Object.create(null); // effect id -> level this frame
    this.sceneName = '';
    this.sceneIndex = -1;
    this.sceneProgress = 0;
    this.activeLayers = [];
    this.totalBars = show.reduce((s, sc) => s + sc.bars, 0);

    // How many times the show has looped. Seeds the per-cycle variation, so a
    // scene picks different effects and levels each time round but is identical
    // on any replay of the same cycle.
    this.cycle = 0;
    this._lastBar = 0;
  }

  reset() {
    this.bar = 0;
    this.levels = Object.create(null);
    this.activeLayers = [];
    this.sceneIndex = -1;
    this.sceneName = '';
  }

  // Jump to the start of the next scene. `dir` of -1 goes back to the start of
  // the current scene, then to the previous one.
  skip(dir = 1) {
    const starts = [];
    let acc = 0;
    for (const sc of this.show) { starts.push(acc); acc += sc.bars; }

    if (dir > 0) {
      const next = starts.find((s) => s > this.bar + 1e-4);
      this.bar = next === undefined ? 0 : next;
    } else {
      const here = this.sceneIndex < 0 ? 0 : this.sceneIndex;
      // More than a bar into the scene? Restart it. Otherwise step back one.
      const atStart = this.bar - starts[here] < 1.0;
      const target = atStart ? (here - 1 + this.show.length) % this.show.length : here;
      this.bar = starts[target];
    }
  }

  // `tempo` is the TempoTracker. Locked -> the show runs on the detected BPM;
  // unlocked -> it falls back to 120 so it still plays with no audio.
  update(dt, tempo) {
    if (!this.enabled) {
      if (this.sceneIndex !== -1) this.reset();
      return;
    }

    const bpm = tempo.locked && tempo.bpm ? tempo.bpm : 120;
    const barsPerSecond = bpm / 60 / 4; // 4/4
    this.bar = (this.bar + dt * barsPerSecond) % this.totalBars;

    // Wrapped past the end -> next cycle, which rerolls every hashed value.
    if (this.bar < this._lastBar) this.cycle++;
    this._lastBar = this.bar;

    // Locate the current scene.
    let start = 0;
    let scene = this.show[0];
    let index = 0;
    for (let i = 0; i < this.show.length; i++) {
      const sc = this.show[i];
      if (this.bar < start + sc.bars) { scene = sc; index = i; break; }
      start += sc.bars;
    }

    const t = Math.min(1, Math.max(0, (this.bar - start) / scene.bars));
    this.sceneIndex = index;
    this.sceneName = scene.name;
    this.sceneProgress = t;

    // Evaluate every layer in the scene. Two layers naming the same effect take
    // the louder of the two rather than the last one written.
    const levels = Object.create(null);
    const active = [];
    scene.layers.forEach((layer, li) => {
      // Seed is (scene + layer, cycle): stable for the whole scene, different
      // per layer, rerolled once per loop of the show.
      const seedA = index * 101 + li;

      // fx may be a list — pick one per cycle, so a scene can be "some kind of
      // break" rather than always the same effect.
      const fx = Array.isArray(layer.fx)
        ? layer.fx[Math.floor(hash2(seedA, this.cycle) * layer.fx.length) % layer.fx.length]
        : layer.fx;

      const from = resolve(layer.from, seedA + 7, this.cycle);
      const to = resolve(layer.to, seedA + 13, this.cycle);

      const ease = EASE[layer.curve] || EASE.in;
      const v = from + (to - from) * ease(t);

      levels[fx] = Math.max(levels[fx] || 0, v);
      active.push({ fx, level: v });
    });

    this.levels = levels;
    this.activeLayers = active;
  }
}
