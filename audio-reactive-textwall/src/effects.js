// Effect registry + envelopes.
//
// An effect is one fragment shader file that defines `vec4 fx(vec2 uv)`. It gets
// a single `uProgress` uniform that runs 0 -> 1 -> 0, so every effect reverses
// back to the resting wall for free: write the shader as "displacement scaled by
// uProgress" and the return trip is automatic.

import { createProgram } from './gl.js';

// Holds are roughly doubled from the first pass. The originals were tuned by
// firing an effect and watching it in isolation, where a short hold reads as
// punchy; in a running show they went by before you could see what they were.
// Attacks and releases are unchanged — those are the effect's character, the
// hold is just how long you get to look at it.
export const EFFECTS = [
  { id: 'liquid',   label: 'Liquid',    key: '1', file: 'shaders/liquid.frag',   attack: 0.55, hold: 2.60, release: 1.30 },
  { id: 'blowaway', label: 'Blow away', key: '2', file: 'shaders/blowaway.frag', attack: 0.45, hold: 0.90, release: 1.10 },
  { id: 'explode',  label: 'Explode',   key: '3', file: 'shaders/explode.frag',  attack: 0.28, hold: 0.45, release: 0.85 },
  { id: 'melt',     label: 'Melt',      key: '4', file: 'shaders/melt.frag',     attack: 0.90, hold: 2.20, release: 1.60 },
  { id: 'shatter',  label: 'Shatter',   key: '5', file: 'shaders/shatter.frag',  attack: 0.30, hold: 1.10, release: 1.10 },
  { id: 'ripple',   label: 'Ripple',    key: '6', file: 'shaders/ripple.frag',   attack: 0.40, hold: 3.00, release: 1.00 },
  { id: 'glitch',   label: 'Glitch',    key: '7', file: 'shaders/glitch.frag',   attack: 0.12, hold: 1.00, release: 0.45 },
  { id: 'vortex',   label: 'Vortex',    key: '8', file: 'shaders/vortex.frag',   attack: 0.65, hold: 1.60, release: 1.30 },
  // Built from the reference shaders in shaders/reference/ — fields ported, not code.
  { id: 'filament', label: 'Filament',  key: '9', file: 'shaders/filament.frag', attack: 0.70, hold: 2.80, release: 1.40 },
  { id: 'neon',     label: 'Neon',      key: '0', file: 'shaders/neon.frag',     attack: 0.50, hold: 4.20, release: 1.20 },
  { id: 'dune',     label: 'Dune',      key: 'q', file: 'shaders/dune.frag',     attack: 0.80, hold: 4.60, release: 1.50 },
  { id: 'plasma',   label: 'Plasma',    key: 'w', file: 'shaders/plasma.frag',   attack: 0.35, hold: 3.40, release: 1.10 },
  { id: 'terminal', label: 'Terminal',  key: 'e', file: 'shaders/terminal.frag', attack: 1.30, hold: 3.80, release: 1.30 },
  { id: 'tiles',    label: 'Tiles',     key: 'r', file: 'shaders/tiles.frag',    attack: 0.60, hold: 5.00, release: 1.20 },
  // Reads the persistent fluid field maintained by shaders/fluid.frag.
  { id: 'advect',   label: 'Advect',    key: 't', file: 'shaders/advect.frag',   attack: 0.45, hold: 6.00, release: 1.40 },
  // Needs the uFFT spectrum texture — per-column frequency addressing.
  { id: 'spectrum', label: 'Spectrum',  key: 'y', file: 'shaders/spectrum.frag', attack: 0.40, hold: 6.00, release: 1.00 },
  { id: 'shutter',  label: 'Shutter',   key: 'u', file: 'shaders/shutter.frag',  attack: 0.55, hold: 1.60, release: 0.95 },
  // Reads the particle density field maintained by particles.frag + density.frag.
  { id: 'paint',    label: 'Paint',     key: 'i', file: 'shaders/paint.frag',    attack: 0.60, hold: 7.00, release: 1.30 },
  // Reads the 64-node array maintained by points.frag. Links carry the spectrum.
  { id: 'constellation', label: 'Network', key: 'o', file: 'shaders/constellation.frag', attack: 0.50, hold: 8.00, release: 1.20 },
];

// Selectable base scenes. Pass 0 renders one of these; everything downstream
// samples uSrc and is indifferent to which one ran.
export const SCENES = [
  { id: 'wall',  label: 'Wall — reactive type',  file: 'shaders/base.frag' },
  { id: 'drift', label: 'Drift — tunnel',        file: 'shaders/drift.frag' },
  { id: 'horizons', label: 'Horizons — landscape', file: 'shaders/horizons.frag' },
];
const CURSOR = { id: 'cursor', file: 'shaders/cursor.frag' };
const POST = { id: 'post', file: 'shaders/post.frag' };
const TRAILS = { id: 'trails', file: 'shaders/trails.frag' };
const FLUID = { id: 'fluid', file: 'shaders/fluid.frag' };
const PARTICLES = { id: 'particles', file: 'shaders/particles.frag' };
const DENSITY = { id: 'density', file: 'shaders/density.frag' };
const POINTS = { id: 'points', file: 'shaders/points.frag' };

const easeIn = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 2.2);

export class EffectStack {
  constructor(gl) {
    this.gl = gl;
    this.scenes = new Map();
    this.sceneId = 'wall';
    this.cursor = null;
    this.post = null;
    this.effects = [];
    this.errors = [];

    // Where a fired effect is seeded. 'mouse' pins it to the cursor, 'scatter'
    // picks a fresh random point each fire. Never hard-coded to the centre.
    this.originMode = 'scatter';
    this.origin = [0.5, 0.5];
    this.mouse = [0.5, 0.5];
    this.cursorEnabled = true;

    // Final post stage. Runs last, always, unless switched off entirely.
    this.postEnabled = true;
  }

  async load() {
    const prelude = await fetchText('shaders/prelude.glsl');
    const build = async (def) => {
      const body = await fetchText(def.file);
      const src = `#version 300 es\n${prelude}\n${body}\nvoid main(){ fragColor = fx(vUv); }\n`;
      return createProgram(this.gl, src, def.id);
    };

    for (const sc of SCENES) {
      this.scenes.set(sc.id, { ...sc, program: await build(sc) });
    }
    this.cursor = { ...CURSOR, program: await build(CURSOR) };
    this.post = { ...POST, program: await build(POST) };
    this.trails = { ...TRAILS, program: await build(TRAILS) };
    this.fluid = { ...FLUID, program: await build(FLUID) };
    this.particles = { ...PARTICLES, program: await build(PARTICLES) };
    this.density = { ...DENSITY, program: await build(DENSITY) };
    this.points = { ...POINTS, program: await build(POINTS) };

    this.effects = [];
    for (const def of EFFECTS) {
      try {
        this.effects.push({
          ...def,
          program: await build(def),
          phase: 'idle',
          t: 0,
          progress: 0,
          armed: true, // eligible for auto-fire
        });
      } catch (err) {
        this.errors.push(err.message);
        console.error(err);
      }
    }
    return this;
  }

  get(id) {
    return this.effects.find((e) => e.id === id);
  }

  fire(id) {
    const fx = this.get(id);
    if (!fx) return;
    this.origin = this.originMode === 'mouse'
      ? [this.mouse[0], this.mouse[1]]
      : [0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7];
    // Re-firing mid-flight restarts the attack from wherever it currently is.
    fx.phase = 'attack';
    fx.t = fx.progress * fx.attack;
  }

  // Arming decides what auto-fire is allowed to pick. It does not fire anything
  // itself and does not touch the envelope — firing by hand or from the
  // sequencer works on a disarmed effect exactly as before. This is a filter on
  // the random pool, nothing more.
  toggle(id) {
    const fx = this.get(id);
    if (!fx) return false;
    fx.armed = !fx.armed;
    return fx.armed;
  }

  setAllArmed(on) {
    for (const fx of this.effects) fx.armed = on;
  }

  // True when at least one effect is armed — the UI uses this to explain why
  // auto-fire is doing nothing rather than looking broken.
  get anyArmed() {
    return this.effects.some((e) => e.armed);
  }

  fireRandom() {
    const armed = this.effects.filter((e) => e.armed);
    if (!armed.length) return; // nothing selected: auto-fire has nothing to do
    // Prefer one that is not already running, so a full rack cycles rather than
    // retriggering the same effect over and over.
    const idle = armed.filter((e) => e.phase === 'idle');
    const pool = idle.length ? idle : armed;
    this.fire(pool[Math.floor(Math.random() * pool.length)].id);
  }

  update(dt) {
    for (const fx of this.effects) {
      if (fx.phase === 'idle') { fx.progress = 0; continue; }
      fx.t += dt;

      if (fx.phase === 'attack') {
        if (fx.t >= fx.attack) { fx.phase = 'hold'; fx.t = 0; fx.progress = 1; }
        else fx.progress = easeIn(fx.t / fx.attack);
      } else if (fx.phase === 'hold') {
        fx.progress = 1;
        if (fx.t >= fx.hold) { fx.phase = 'release'; fx.t = 0; }
      } else if (fx.phase === 'release') {
        if (fx.t >= fx.release) { fx.phase = 'idle'; fx.t = 0; fx.progress = 0; }
        else fx.progress = 1 - easeOut(fx.t / fx.release);
      }
    }
  }

  // Fold sequencer levels in on top of the manual envelopes. Taking the max
  // rather than overwriting means firing an effect by hand during a show still
  // works — the hit rides over whatever the director is holding.
  applyLevels(levels) {
    for (const fx of this.effects) {
      const lvl = levels[fx.id];
      if (lvl > 0.001) fx.progress = Math.max(fx.progress, lvl);
    }
  }

  // Passes to run this frame, in order. Base is always first.
  activePasses() {
    const scene = this.scenes.get(this.sceneId) || this.scenes.get('wall');
    const passes = [{ program: scene.program, progress: 1 }];
    if (this.cursorEnabled) passes.push({ program: this.cursor.program, progress: 1 });
    for (const fx of this.effects) {
      if (fx.progress > 0.001) passes.push({ program: fx.program, progress: fx.progress });
    }
    // Post always runs last — it anti-aliases whatever the chain produced.
    if (this.postEnabled) passes.push({ program: this.post.program, progress: 1 });
    return passes;
  }
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status}). Serve over http, not file://`);
  return res.text();
}
