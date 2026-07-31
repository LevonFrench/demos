import { createContext, createProgram, createTexture, createPingPong, disposePingPong, setUniforms } from './gl.js';
import { drawWall, wall } from './textwall.js';
import { AudioEngine } from './audio.js';
import { EffectStack, EFFECTS, SCENES } from './effects.js';
import { Sequencer } from './sequencer.js';

const canvas = document.getElementById('stage');
const { gl } = createContext(canvas);

const state = {
  text: 'PULSE',
  fontSize: 44,
  kerning: 0,     // em of extra letter spacing on the wall
  leading: 1.32,  // row pitch as a multiple of the font size
  scrollCells: 0.5, // words the wall travels per bar, at the detected tempo
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  auto: false,
  pulse: false,     // reactive motion on the resting wall — off by default
  beatPulse: false, // global gate on uBeat: off kills beat-driven pulsing everywhere
  fxaa: true,   // post pass: edge anti-aliasing
  grain: 0.35,  // post pass: film grain amount
  dof: 1.0,     // post pass: max defocus radius, driven by effect alpha
  bloom: 0.5,   // post pass: threshold bloom strength
  tone: 0,      // post pass: ACES highlight roll-off. Off by default — it is a
                // re-grade, and every palette was tuned without it.
  fluid: 1.0,   // fluid simulation injection strength, 0 = sim idle
  trails: 0,    // temporal feedback: time constant in seconds
  width: 0,
  height: 0,
};

// Pointer state. Velocity is smoothed so a flick smears instead of snapping.
const pointer = {
  uv: [0.5, 0.5],
  target: [0.5, 0.5],
  vel: [0, 0],
  down: 0,
  downTarget: 0,
};

const audio = new AudioEngine();
const stack = new EffectStack(gl);
const seq = new Sequencer();

// One-row spectrum texture, re-uploaded every frame.
const fftTex = createTexture(gl);
gl.bindTexture(gl.TEXTURE_2D, fftTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, audio.spectrum.length, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);

function uploadSpectrum() {
  gl.bindTexture(gl.TEXTURE_2D, fftTex);
  // Single-channel rows are not 4-byte aligned; without this the upload is
  // silently skewed.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, audio.spectrum.length, 1,
                   gl.RED, gl.UNSIGNED_BYTE, audio.spectrum);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
}

const textTex = createTexture(gl);
// The drift scene samples this minified by 10x or more at depth. Without
// mipmaps that aliases into pure noise, and without REPEAT the tiling has to be
// done with fract(), which breaks the derivatives mipmapping depends on.
gl.bindTexture(gl.TEXTURE_2D, textTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
let targets = null;
// Presented-frame history for the trails pass. Ping-ponged so we never read and
// write the same texture in one draw.
let history = null;
let histIndex = 0;

// Persistent fluid state. Half the display resolution — fluid is smooth by
// nature, so the detail is wasted, and it makes the extra pass nearly free.
const SIM_SCALE = 0.5;
let sim = null;
let simIndex = 0;
let simSize = [1, 1];
// Particle solver state. Quarter resolution — one particle per pixel means the
// count scales with area, and the 3x3 gather runs twice per frame.
const PART_SCALE = 0.35;
let part = null;
let partIndex = 0;
let dens = null;
let partSize = [1, 1];

// 64x2 node array — position/velocity in row 0, nearest-neighbour link in row 1.
const NODES = 64;
let pts = null;
let ptsIndex = 0;

const canFloat = !!gl.getExtension('EXT_color_buffer_float');
if (!canFloat) console.warn('EXT_color_buffer_float missing — fluid simulation disabled.');

// ---------------------------------------------------------------- text upload

function uploadWall() {
  drawWall({
    width: state.width,
    height: state.height,
    text: state.text,
    fontSize: state.fontSize,
    kerning: state.kerning,
    leading: state.leading,
    dpr: state.dpr,
  });
  gl.bindTexture(gl.TEXTURE_2D, textTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, wall.canvas);
  gl.generateMipmap(gl.TEXTURE_2D); // must be regenerated on every re-render
}

function resize() {
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  const w = Math.max(1, Math.round(state.width * state.dpr));
  const h = Math.max(1, Math.round(state.height * state.dpr));
  canvas.width = w;
  canvas.height = h;

  if (targets) disposePingPong(gl, targets);
  targets = createPingPong(gl, w, h);

  if (history) disposePingPong(gl, history);
  history = createPingPong(gl, w, h);
  // Clear both, or the first trails frame samples uninitialised memory.
  for (const h2 of history) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, h2.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (canFloat) {
    if (sim) disposePingPong(gl, sim);
    simSize = [Math.max(1, Math.round(w * SIM_SCALE)), Math.max(1, Math.round(h * SIM_SCALE))];
    sim = createPingPong(gl, simSize[0], simSize[1], true);
    for (const s of sim) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (part) disposePingPong(gl, part);
    if (dens) disposePingPong(gl, dens);
    partSize = [Math.max(1, Math.round(w * PART_SCALE)), Math.max(1, Math.round(h * PART_SCALE))];
    part = createPingPong(gl, partSize[0], partSize[1], true);
    dens = createPingPong(gl, partSize[0], partSize[1], true);
    if (pts) disposePingPong(gl, pts);
    pts = createPingPong(gl, NODES, 2, true);

    for (const t of [...part, ...dens, ...pts]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  uploadWall();
}

window.addEventListener('resize', resize);

// ---------------------------------------------------------------- render loop

let last = performance.now();
let scrollBars = 0; // bars elapsed, integrated from the live tempo

function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;

  audio.update(dt);
  uploadSpectrum();
  updatePointer(dt);
  stack.update(dt);

  // BPM -> scroll speed. A bar is four beats, so at B BPM one bar takes
  // 240/B seconds; advancing `scrollBars` by dt/barSeconds makes one unit of it
  // exactly one bar however the tempo drifts. Multiplying by cells-per-bar puts
  // uScroll in cells, and one cell is one word — so the wall travels a whole
  // number of words per bar and stays in step with the track.
  //
  // Integrating a rate rather than reading tempo.barPhase directly is what
  // keeps it smooth: barPhase jumps when the tracker re-anchors, and a jump in
  // a position is a visible skip. A jump in a *speed* is not.
  const bpm = audio.tempo.locked && audio.tempo.bpm ? audio.tempo.bpm : audio.bpm;
  scrollBars += dt / (240 / bpm);
  // Wrap in whole cells so the reset is invisible; the texture tiles exactly.
  const scroll = (scrollBars * state.scrollCells) % 1024;

  // The director runs after the manual envelopes and folds its layers on top.
  seq.update(dt, audio.tempo);
  if (seq.enabled) stack.applyLevels(seq.levels);

  const passes = stack.activePasses();
  const uniforms = {
    iResolution: [canvas.width, canvas.height],
    iTime: now / 1000,
    uLevel: audio.level,
    uBass: audio.bass,
    uMid: audio.mid,
    uTreble: audio.treble,
    // One gate for every beat-driven pulse in the project. Every shader reads
    // uBeat, so zeroing it here switches all of them off without touching any
    // shader — cheaper and more complete than a per-effect control. The 0.5 is
    // a global depth trim for the same reason: 19 shaders, one number.
    uBeat: state.beatPulse ? audio.beat * 0.5 : 0.0,
    uPulse: state.pulse ? 1 : 0,
    uScroll: scroll,
    uCell: wall.cell,
    uOrigin: stack.origin,
    uMouse: pointer.uv,
    uMouseVel: pointer.vel,
    uMouseDown: pointer.down,
    uCursor: stack.cursorEnabled ? 1 : 0,
    uPhase: audio.tempo.phase,
    uBar: audio.tempo.barPhase,
    uLocked: audio.tempo.locked ? 1 : 0,
    uFxaa: state.fxaa ? 1 : 0,
    uGrain: state.grain,
    uDof: state.dof,
    uBloom: state.bloom,
    uTone: state.tone,
    uFluid: state.fluid,
    uTexel: [1 / simSize[0], 1 / simSize[1]],
    uPTexel: [1 / partSize[0], 1 / partSize[1]],
    uDt: dt,
    uTrails: state.trails,
    uSceneProg: seq.enabled ? seq.sceneProgress : 0,
    uScene: seq.enabled ? seq.sceneIndex : -1,
  };

  gl.viewport(0, 0, canvas.width, canvas.height);

  const drawPass = (program, extra, srcTex, histTex, fbo) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.useProgram(program.prog);
    setUniforms(gl, program, { ...uniforms, ...extra });

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(program.uniforms.get('uSrc'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    const uText = program.uniforms.get('uText');
    if (uText) gl.uniform1i(uText, 1);

    const uHist = program.uniforms.get('uHist');
    if (uHist) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, histTex);
      gl.uniform1i(uHist, 2);
    }

    const uFFT = program.uniforms.get('uFFT');
    if (uFFT) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, fftTex);
      gl.uniform1i(uFFT, 4);
    }

    const uPts = program.uniforms.get('uPts');
    if (uPts && pts) {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, pts[ptsIndex].tex);
      gl.uniform1i(uPts, 7);
    }

    const uPart = program.uniforms.get('uPart');
    if (uPart && part) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, part[partIndex].tex);
      gl.uniform1i(uPart, 5);
    }

    const uDens = program.uniforms.get('uDens');
    if (uDens && dens) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, dens[0].tex);
      gl.uniform1i(uDens, 6);
    }

    const uSim = program.uniforms.get('uSim');
    if (uSim && sim) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, sim[simIndex].tex);
      gl.uniform1i(uSim, 3);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Simulation step, before anything reads it. Runs at sim resolution, so the
  // viewport has to change and change back.
  if (sim && state.fluid > 0.001) {
    const prev = sim[simIndex];
    const next = sim[simIndex ^ 1];
    gl.viewport(0, 0, simSize[0], simSize[1]);
    drawPass(stack.fluid.program, { uTexel: [1 / simSize[0], 1 / simSize[1]] },
             prev.tex, null, next.fbo);
    simIndex ^= 1;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Particle solver. Density first, because the particle step reads it back for
  // the pressure gradient — order matters and it is one frame behind either way.
  if (part && stack.get('paint') && stack.get('paint').progress > 0.001) {
    const pTexel = [1 / partSize[0], 1 / partSize[1]];
    gl.viewport(0, 0, partSize[0], partSize[1]);
    drawPass(stack.density.program, { uPTexel: pTexel }, part[partIndex].tex, null, dens[0].fbo);
    drawPass(stack.particles.program, { uPTexel: pTexel },
             part[partIndex].tex, null, part[partIndex ^ 1].fbo);
    partIndex ^= 1;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Node array. Runs at 64x2, so the nearest-neighbour search costs 64x64 tests
  // in total rather than per screen pixel.
  if (pts && stack.get('constellation') && stack.get('constellation').progress > 0.001) {
    gl.viewport(0, 0, NODES, 2);
    drawPass(stack.points.program, {}, pts[ptsIndex].tex, null, pts[ptsIndex ^ 1].fbo);
    ptsIndex ^= 1;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  const useTrails = state.trails > 0.001;

  // With trails on, the chain has to land in a texture rather than on screen, so
  // the feedback pass has something to read.
  let sourceTex = textTex;
  for (let i = 0; i < passes.length; i++) {
    const isLast = i === passes.length - 1;
    const dst = targets[i % 2];
    const toScreen = isLast && !useTrails;
    drawPass(passes[i].program, { uProgress: passes[i].progress }, sourceTex, null,
             toScreen ? null : dst.fbo);
    sourceTex = dst.tex;
  }

  if (useTrails) {
    const prev = history[histIndex];
    const next = history[histIndex ^ 1];
    // Once into the history buffer, once to the screen. Drawing twice is cheaper
    // and simpler than a separate blit shader, and both reads are of `prev`, so
    // there is no read-write hazard.
    drawPass(stack.trails.program, {}, sourceTex, prev.tex, next.fbo);
    drawPass(stack.trails.program, {}, sourceTex, prev.tex, null);
    histIndex ^= 1;
  }

  updateMeters();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------- UI

function updatePointer(dt) {
  // Critically-damped chase toward the raw cursor position.
  const k = 1 - Math.exp(-dt * 14);
  const px = pointer.uv[0];
  const py = pointer.uv[1];
  pointer.uv[0] += (pointer.target[0] - px) * k;
  pointer.uv[1] += (pointer.target[1] - py) * k;

  // Velocity in UV/sec, low-passed so it decays instead of popping to zero.
  const vx = (pointer.uv[0] - px) / Math.max(dt, 1e-4);
  const vy = (pointer.uv[1] - py) / Math.max(dt, 1e-4);
  const damp = Math.exp(-dt * 6);
  pointer.vel[0] = pointer.vel[0] * damp + vx * (1 - damp);
  pointer.vel[1] = pointer.vel[1] * damp + vy * (1 - damp);

  pointer.down += (pointer.downTarget - pointer.down) * (1 - Math.exp(-dt * 10));

  stack.mouse = pointer.uv;
}

function setPointerFromEvent(e) {
  pointer.target[0] = e.clientX / window.innerWidth;
  pointer.target[1] = 1 - e.clientY / window.innerHeight; // texture is Y-flipped
}

canvas.addEventListener('pointermove', setPointerFromEvent);
canvas.addEventListener('pointerdown', (e) => {
  setPointerFromEvent(e);
  pointer.downTarget = 1;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  pointer.downTarget = 0;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointercancel', () => { pointer.downTarget = 0; });
canvas.addEventListener('pointerleave', () => { pointer.downTarget = 0; });

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const hint = $('hint');

// ------------------------------------------------------------------ how-to
// Opens itself once per browser, then only on demand. The flag is stored under
// a versioned key so that changing the guide can re-show it to people who have
// already dismissed the old one.
const HOWTO_SEEN = 'pulse.howto.v1';
const howtoWrap = $('howtoWrap');
let howtoReturnFocus = null;

function openHowto(fromEl) {
  howtoReturnFocus = fromEl || null;
  howtoWrap.hidden = false;
  // Focus the dialog, not the button at the bottom of it — focusing a control
  // scrolls it into view, which opened the guide already scrolled to the end.
  const dlg = $('howto');
  dlg.scrollTop = 0;
  dlg.focus({ preventScroll: true });
}

function closeHowto() {
  howtoWrap.hidden = true;
  try { localStorage.setItem(HOWTO_SEEN, '1'); } catch { /* private mode */ }
  howtoReturnFocus?.focus();
  howtoReturnFocus = null;
}

$('howtoClose').addEventListener('click', closeHowto);
$('howtoGo').addEventListener('click', closeHowto);
$('help').addEventListener('click', (e) => openHowto(e.currentTarget));
$('helpAudio').addEventListener('click', (e) => openHowto(e.currentTarget));
// Clicking the backdrop, but not the dialog itself.
howtoWrap.addEventListener('click', (e) => { if (e.target === howtoWrap) closeHowto(); });

try {
  if (!localStorage.getItem(HOWTO_SEEN)) openHowto();
} catch {
  // localStorage unavailable (private mode / file://). Show it every time
  // rather than never — a repeated dialog is better than an unusable page.
  openHowto();
}

// The effect buttons are the auto-fire rack: a lit button means auto-fire is
// allowed to pick that effect. Clicking only changes what is eligible — it
// never fires anything. The keyboard shortcut still fires once, so you can
// punch an effect in whether or not it is armed.
const fxButtons = new Map();

function syncFxButtons() {
  for (const [id, b] of fxButtons) {
    b.setAttribute('aria-pressed', String(!!stack.get(id)?.armed));
  }
  // Totals come from the loaded stack, not EFFECTS — a shader that failed to
  // compile has no button, and claiming "of 19" would then be a lie.
  $('armCount').textContent = stack.effects.filter((e) => e.armed).length;
  $('armTotal').textContent = stack.effects.length;
}

function buildFxButtons() {
  const host = $('fxButtons');
  host.textContent = '';
  fxButtons.clear();
  for (const def of EFFECTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${def.label} (${def.key})`;
    b.title = `Auto-fire may pick this · press ${def.key.toUpperCase()} to fire it now`;
    b.addEventListener('click', () => { stack.toggle(def.id); syncFxButtons(); });
    fxButtons.set(def.id, b);
    host.appendChild(b);
  }
  syncFxButtons();
}

function buildSceneSelect() {
  const sel = $('scene');
  sel.textContent = '';
  for (const sc of SCENES) {
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = sc.label;
    sel.appendChild(opt);
  }
  sel.value = stack.sceneId;
  sel.addEventListener('change', (e) => { stack.sceneId = e.target.value; });
}

$('text').addEventListener('input', (e) => {
  state.text = e.target.value;
  uploadWall();
});

$('size').addEventListener('input', (e) => {
  state.fontSize = Number(e.target.value);
  $('sizeOut').textContent = state.fontSize;
  uploadWall();
});

$('kern').addEventListener('input', (e) => {
  state.kerning = Number(e.target.value);
  $('kernOut').textContent = state.kerning.toFixed(2);
  uploadWall();
});

$('lead').addEventListener('input', (e) => {
  state.leading = Number(e.target.value);
  $('leadOut').textContent = state.leading.toFixed(2);
  uploadWall();
});

$('scroll').addEventListener('input', (e) => {
  state.scrollCells = Number(e.target.value);
  $('scrollOut').textContent = state.scrollCells.toFixed(2);
});

$('beatSens').addEventListener('input', (e) => {
  audio.beatSens = Number(e.target.value);
  $('beatSensOut').textContent = audio.beatSens.toFixed(2);
});

$('gain').addEventListener('input', (e) => {
  audio.gain = Number(e.target.value);
  $('gainOut').textContent = audio.gain.toFixed(2);
});

$('auto').addEventListener('change', (e) => { state.auto = e.target.checked; });
$('pulse').addEventListener('change', (e) => { state.pulse = e.target.checked; });
$('beatPulse').addEventListener('change', (e) => { state.beatPulse = e.target.checked; });
$('fxaa').addEventListener('change', (e) => { state.fxaa = e.target.checked; });
$('show').addEventListener('change', (e) => {
  seq.enabled = e.target.checked;
  if (!seq.enabled) seq.reset();
  $('showState').hidden = !seq.enabled;
});
$('nextScene').addEventListener('click', () => seq.skip(1));
$('prevScene').addEventListener('click', () => seq.skip(-1));
$('grain').addEventListener('input', (e) => {
  state.grain = Number(e.target.value);
  $('grainOut').textContent = state.grain.toFixed(2);
});
$('dof').addEventListener('input', (e) => {
  state.dof = Number(e.target.value);
  $('dofOut').textContent = state.dof.toFixed(2);
});
$('tone').addEventListener('input', (e) => {
  state.tone = Number(e.target.value);
  $('toneOut').textContent = state.tone.toFixed(2);
});
$('fluid').addEventListener('input', (e) => {
  state.fluid = Number(e.target.value);
  $('fluidOut').textContent = state.fluid.toFixed(2);
});
$('bloom').addEventListener('input', (e) => {
  state.bloom = Number(e.target.value);
  $('bloomOut').textContent = state.bloom.toFixed(2);
});
$('trails').addEventListener('input', (e) => {
  state.trails = Number(e.target.value);
  $('trailsOut').textContent = state.trails.toFixed(2);
});
$('cursorFx').addEventListener('change', (e) => { stack.cursorEnabled = e.target.checked; });
$('origin').addEventListener('change', (e) => { stack.originMode = e.target.value; });
$('hide').addEventListener('click', () => { panel.hidden = true; });

const sourceButtons = { system: $('system'), mic: $('mic'), pick: $('pick'), metro: $('metro') };

function markSource(mode) {
  sourceButtons.system.setAttribute('aria-pressed', String(mode === 'system'));
  sourceButtons.mic.setAttribute('aria-pressed', String(mode === 'mic'));
  sourceButtons.pick.setAttribute('aria-pressed', String(mode === 'file'));
  sourceButtons.metro.setAttribute('aria-pressed', String(mode === 'metronome'));
  $('scan').setAttribute('aria-pressed', String(mode === 'device'));
  hint.hidden = mode !== 'metronome';
}

async function useSystemAudio() {
  try {
    await audio.useSystemAudio();
    markSource('system');
  } catch (err) {
    console.error(err);
    hint.hidden = false;
    hint.textContent = err.name === 'NotAllowedError'
      ? 'Screen share was cancelled — still on the metronome.'
      : err.message;
  }
}

sourceButtons.system.addEventListener('click', useSystemAudio);

// Device route — the good one. Enumerate inputs, flag anything that looks like
// a loopback, and connect on selection. No picker, and the grant persists.
const deviceSel = $('inputDevice');

$('scan').addEventListener('click', async () => {
  try {
    const inputs = await audio.listInputs();
    deviceSel.textContent = '';

    if (!inputs.length) {
      hint.hidden = false;
      hint.textContent = 'No audio inputs found.';
      return;
    }

    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = (d.loopback ? '● ' : '   ') + d.label;
      deviceSel.appendChild(opt);
    }
    deviceSel.hidden = false;

    // Pre-select a loopback if one exists — that is what the user actually wants.
    const loop = inputs.find((d) => d.loopback);
    if (loop) {
      deviceSel.value = loop.deviceId;
      await audio.useDevice(loop.deviceId);
      markSource('device');
    } else {
      hint.hidden = false;
      hint.textContent = 'No loopback device found — see the note under Audio source.';
    }
  } catch (err) {
    console.error(err);
    hint.hidden = false;
    hint.textContent = `Could not list inputs: ${err.message}`;
  }
});

deviceSel.addEventListener('change', async (e) => {
  try {
    await audio.useDevice(e.target.value);
    markSource('device');
  } catch (err) {
    console.error(err);
    hint.hidden = false;
    hint.textContent = `Could not open that input: ${err.message}`;
  }
});
audio.onSourceEnded = () => markSource('metronome');

async function useMic() {
  try {
    await audio.useMic();
    markSource('mic');
  } catch (err) {
    console.error(err);
    hint.hidden = false;
    hint.textContent = 'Microphone was blocked — falling back to the metronome.';
  }
}

sourceButtons.mic.addEventListener('click', useMic);
sourceButtons.metro.addEventListener('click', () => { audio.useMetronome(); markSource('metronome'); });
sourceButtons.pick.addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await loadFile(file);
});

async function loadFile(file) {
  try {
    await audio.useFile(file);
    markSource('file');
  } catch (err) {
    console.error(err);
    hint.hidden = false;
    hint.textContent = `Could not play that file: ${err.message}`;
  }
}

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('audio/')) await loadFile(file);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;

  // The how-to swallows everything while it is open, so a shortcut pressed
  // behind a modal cannot silently take effect.
  if (!howtoWrap.hidden) {
    if (e.key === 'Escape' || e.key === '?' || e.key === 'Enter') closeHowto();
    return;
  }
  if (e.key === '?') { openHowto(); return; }
  // Shift+1 reports as "!", so fall back to the physical key for the digits —
  // otherwise shift-latching silently does nothing on half the effects.
  const k = e.code.startsWith('Digit') ? e.code.slice(5) : e.key.toLowerCase();
  const def = EFFECTS.find((d) => d.key === k);
  if (def) {
    if (e.shiftKey) { stack.toggle(def.id); syncFxButtons(); }
    else stack.fire(def.id);
    return;
  }
  // X flips the whole rack: if anything is armed, clear it; otherwise arm all.
  if (k === 'x') { stack.setAllArmed(!stack.anyArmed); syncFxButtons(); return; }
  if (k === 'h') panel.hidden = !panel.hidden;
  if (k === 'm') useMic();
  if (k === 's') useSystemAudio();
  if (k === 'a') { state.auto = !state.auto; $('auto').checked = state.auto; }
  if (k === ']') seq.skip(1);
  if (k === '[') seq.skip(-1);
});

const meters = { uBass: $('mBass'), uMid: $('mMid'), uTre: $('mTre') };
// Live layer readout. Rows are reused rather than rebuilt so the DOM is not
// churned every frame.
const layerList = $('layerList');
function updateShowReadout() {
  if (!seq.enabled) return;

  $('sceneName').textContent = seq.sceneName || '—';
  $('sceneBar').textContent = `${seq.sceneIndex + 1}/${seq.show.length} · bar ${(seq.bar).toFixed(1)}`;
  $('sceneFill').style.transform = `scaleX(${seq.sceneProgress.toFixed(3)})`;

  const rows = seq.activeLayers;
  while (layerList.children.length < rows.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="bar"><span></span></span><span class="lvl"></span>';
    layerList.appendChild(li);
  }
  while (layerList.children.length > rows.length) layerList.lastChild.remove();

  rows.forEach((row, i) => {
    const li = layerList.children[i];
    li.querySelector('.name').textContent = row.fx;
    li.querySelector('.bar > span').style.transform = `scaleX(${Math.max(0, Math.min(1, row.level)).toFixed(3)})`;
    li.querySelector('.lvl').textContent = row.level.toFixed(2);
  });
}

function updateMeters() {
  if (panel.hidden) return;
  updateBpmReadout();
  updateShowReadout();
  $('beatDot').style.opacity = String(0.25 + (1 - audio.tempo.phase) * 0.75);
  meters.uBass.style.transform = `scaleX(${audio.bass.toFixed(3)})`;
  meters.uMid.style.transform = `scaleX(${audio.mid.toFixed(3)})`;
  meters.uTre.style.transform = `scaleX(${audio.treble.toFixed(3)})`;
}

// Once the tempo is locked, effects fire on the predicted grid rather than on
// raw onsets — that is what makes it feel timed to the track instead of merely
// triggered by it. Unlocked, fall back to raw onsets.
//
// Firing on the *beat* and not the downbeat matters: hanging auto-fire off
// onDownbeat quartered the rate the moment the tempo locked, which read as
// auto-fire dying a second after you switched it on.
audio.tempo.onBeat = () => {
  if (state.auto) stack.fireRandom();
};

audio.onBeat = () => {
  if (state.auto && !audio.tempo.locked) stack.fireRandom();
};

const bpmOut = $('bpmOut');
function updateBpmReadout() {
  const t = audio.tempo;
  if (!t.locked) {
    bpmOut.textContent = 'listening…';
    bpmOut.dataset.locked = 'false';
    return;
  }
  bpmOut.textContent = `${Math.round(t.bpm)} BPM · ${Math.round(t.confidence * 100)}%`;
  bpmOut.dataset.locked = 'true';
}

// ---------------------------------------------------------------------- boot

(async function boot() {
  try {
    await stack.load();
  } catch (err) {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<pre style="position:fixed;inset:auto 1rem 1rem 1rem;max-height:40vh;overflow:auto;padding:1rem;background:#200;color:#f88;border-radius:8px;white-space:pre-wrap">${escapeHtml(err.message)}</pre>`
    );
    return;
  }
  if (stack.errors.length) console.warn('Some effects failed to compile:', stack.errors);

  buildFxButtons();
  buildSceneSelect();
  markSource('metronome');
  resize();
  requestAnimationFrame(frame);
})();

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
