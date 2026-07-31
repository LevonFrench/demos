// Injected above every effect file. Do not add a #version line here — the loader
// prepends it. Every effect file just defines:  vec4 fx(vec2 uv) { ... }
precision highp float;

uniform sampler2D uSrc;   // output of the previous pass (the wall, for pass 0)
uniform sampler2D uText;  // the untouched text wall, always available
uniform vec2  iResolution;
uniform float iTime;
uniform float uProgress;  // 0 -> 1 -> 0 envelope for this effect
uniform float uLevel;     // overall RMS      0..1
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;      // 1 on transient, decays fast
uniform float uPulse;     // 0 = wall holds perfectly still, 1 = full reaction
uniform vec2  uCell;      // one word cell, in UV units
uniform vec2  uOrigin;    // where the current effect was seeded, in UV (not the centre)
uniform vec2  uMouse;     // cursor position in UV
uniform vec2  uMouseVel;  // cursor velocity in UV/sec, smoothed
uniform float uMouseDown; // 0..1, eased press state
uniform float uCursor;    // 0 = cursor does nothing to the wall
uniform float uPhase;     // 0..1 through the current beat, from the tempo lock
uniform float uBar;       // 0..1 through a 4-beat bar
uniform float uLocked;    // 1 when the tempo tracker has a confident BPM
uniform float uFxaa;      // post pass: edge anti-aliasing on/off
uniform float uGrain;     // post pass: film grain amount, 0 = off
uniform float uDof;       // post pass: max defocus radius, 0 = off
uniform float uBloom;     // post pass: bloom strength, 0 = off
uniform float uTone;      // post pass: ACES highlight roll-off, 0 = off
uniform sampler2D uHist;  // last frame's presented image (trails pass only)
uniform sampler2D uSim;   // fluid state: xy = velocity (px/frame), z = pressure
uniform vec2 uTexel;      // 1.0 / simulation resolution
uniform float uFluid;     // fluid injection strength, 0 = simulation idle
uniform sampler2D uFFT;   // 256-bin spectrum, one row. See fft() below.
uniform sampler2D uPart;  // particle state: xy = sub-cell offset, zw = velocity
uniform sampler2D uDens;  // splatted field: x = density, yz = momentum
uniform vec2 uPTexel;     // 1.0 / particle-simulation resolution
// Beat-locked scroll, in CELLS. Advances at a rate derived from the detected
// tempo, so multiplying by uCell gives a UV offset that moves the wall an exact
// number of words per bar. Continuous and unwrapped — the text texture tiles
// exactly (see textwall.js) so REPEAT carries it with no seam.
uniform float uScroll;
uniform sampler2D uPts;   // 64x2 node array: row 0 = pos/vel, row 1 = two neighbours
#define NODE_COUNT 64
#define NO_LINK -9.0     // sentinel in row 1; real positions are always >= 0

// Spectrum lookup. f is 0..1 across the analysed range (roughly 0-6kHz), so
// fft(0.02) is the kick, fft(0.5) upper mids, fft(0.9) air.
//
// Until now shaders only had uBass/uMid/uTreble — three numbers for the entire
// spectrum, which means an effect can react to the music but cannot react to a
// *part* of it. With the texture, per-pixel frequency addressing is possible:
// one band per column, per cell, per angle.
//
// Human pitch perception is logarithmic while the bins are linear, so raising f
// to a power around 1.5-2.0 before lookup spreads the bass out and stops
// everything interesting bunching into the leftmost few percent.
float fft(float f) {
  return texture(uFFT, vec2(clamp(f, 0.0, 1.0), 0.5)).r;
}
uniform float uDt;        // seconds since last frame
uniform float uTrails;    // 0 = no feedback, higher = longer trails
uniform float uSceneProg; // 0..1 through the sequencer's current scene
uniform float uScene;     // index of the current scene, -1 when not running

in  vec2 vUv;
out vec4 fragColor;

// Shadertoy aliases so pasted code needs fewer edits.
#define iChannel0 uSrc
#define iChannel1 uText

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float a = 0.5;
  float v = 0.0;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

vec2 rot(vec2 v, float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c) * v;
}

// ---------------------------------------------------------------------------
// ALPHA IS A CONTROL CHANNEL, NOT OPACITY.
//
// Everything composites opaquely, so alpha was dead weight. It now carries a
// FOCUS signal for the post pass to consume:
//
//     1.0 = sharp (the default — return vec4(col, 1.0) and nothing changes)
//     0.0 = maximum blur
//
// An effect that wants part of the frame defocused writes a lower alpha, and
// post.frag turns it into a per-pixel blur radius. Idea taken from a reference
// whose scene pass wrote depth into alpha so its Image pass could do
// depth-of-field from it.
//
// CAVEAT: passes run in sequence and each writes its own alpha, so the LAST
// active effect wins. Two effects both requesting blur will not combine — the
// later one in the registry order decides. Fine in practice; worth knowing.
// ---------------------------------------------------------------------------

// Sample the previous pass, blacking out anything that flew off-screen.
vec4 src(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uSrc, uv);
}

// Tiling sampler, for passes that scroll the wall rather than displace it.
// src() blacks out anything outside the unit square, which is right for an
// effect flinging texels off-screen but wrong for a coordinate that is meant to
// wrap — a drift of one full width would go completely black.
//
// The explicit gradients are load-bearing. fract() is discontinuous at the
// seam, and the implicit derivative there is enormous, so a plain
// texture(uSrc, fract(uv)) picks the smallest mip for that one column and draws
// a blurred line across the wall. Taking dFdx/dFdy of the UNWRAPPED coordinate
// gives the derivative the sampler should have used.
vec4 srcWrap(vec2 uv) {
  return textureGrad(uSrc, fract(uv), dFdx(uv), dFdy(uv));
}
