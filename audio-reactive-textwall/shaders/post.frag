// POST — final always-on pass: edge anti-aliasing and film grain.
//
// Idea from reference/06-synthwave-runner.md, whose Image tab is a post chain
// (FXAA -> grain -> letterbox -> gamma) over a scene rendered in a buffer. This
// project had no post stage at all, which is why thin glyph edges shimmer under
// shatter, glitch and vortex — those effects resample the wall along arbitrary
// directions, and a hard-edged text raster aliases badly when you do that.
//
// FXAA is Timothy Lottes' algorithm (NVIDIA); this is a standard console-variant
// implementation of it. The logic is public and widely reimplemented: estimate
// the local edge direction from the luma of four diagonal neighbours, blur along
// that direction, and reject the result if it overshoots the local luma range.
//
// NOT taken: the reference's final gamma conversion. Its pipeline works in
// linear and converts once at the end. Ours authors colour directly in display
// space — every palette in shaders/ was tuned by eye against the screen — so
// applying pow(1/2.2) here would double-correct and wash the whole thing out.

#define FXAA_SPAN_MAX  8.0
#define FXAA_REDUCE_MUL (1.0 / 8.0)
#define FXAA_REDUCE_MIN (1.0 / 128.0)

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// ACES filmic tone curve — the widely published fitted approximation (originally
// Krzysztof Narkowicz's fit of the ACES RRT/ODT; reference 17 credits Matt
// Taylor's writeup of the same curve).
//
// Purpose here is highlight ROLL-OFF, not colour grading. Bloom, neon cores and
// plasma routinely push channels past 1.0, and without a curve those clip flat:
// a blown highlight loses its hue and turns into a white blob with a hard edge.
// The curve compresses the top end asymptotically, so bright areas keep their
// colour and gain a soft shoulder instead.
//
// NOTE: this is a genuine re-grade. Every palette in shaders/ was tuned by eye
// against an untone-mapped pipeline, so enabling it shifts midtones as well —
// which is why it is a toggle, off by default, rather than always on. Different
// question from the gamma steps rejected in references 06 and 10: those were
// transfer functions that would double-correct, this is a deliberate look.
vec3 acesApprox(vec3 v) {
  v = max(v, 0.0) * 0.6;
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((v * (a * v + b)) / (v * (c * v + d) + e), 0.0, 1.0);
}

vec3 fxaa(vec2 uv, vec2 px) {
  // Luma of the four diagonal neighbours, plus the centre.
  float nw = dot(src(uv + vec2(-1.0, -1.0) * px).rgb, LUMA);
  float ne = dot(src(uv + vec2( 1.0, -1.0) * px).rgb, LUMA);
  float sw = dot(src(uv + vec2(-1.0,  1.0) * px).rgb, LUMA);
  float se = dot(src(uv + vec2( 1.0,  1.0) * px).rgb, LUMA);
  vec3  mC = src(uv).rgb;
  float m  = dot(mC, LUMA);

  float lumaMin = min(m, min(min(nw, ne), min(sw, se)));
  float lumaMax = max(m, max(max(nw, ne), max(sw, se)));

  // Edge direction: perpendicular to the luma gradient across the quad.
  vec2 dir = vec2(-((nw + ne) - (sw + se)), ((nw + sw) - (ne + se)));

  // Keep the step bounded where contrast is low, or noise dominates the estimate.
  float reduce = max((nw + ne + sw + se) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * px;

  // Two-tap average along the edge, then a wider four-tap.
  vec3 rgbA = 0.5 * (src(uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     src(uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (src(uv + dir * -0.5).rgb +
                                   src(uv + dir *  0.5).rgb);

  // If the wider tap overshot the local range it crossed an unrelated edge —
  // fall back to the narrow one.
  float lumaB = dot(rgbB, LUMA);
  return (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
}

// Golden-angle spiral defocus. Each step rotates the sample offset by the golden
// angle and grows the radius by 1/r, which makes the radius progress like sqrt —
// so samples land with uniform density by *area* rather than clustering in the
// middle. Same reasoning as the distance spiral in neon.frag, used here to
// gather colour rather than to search.
vec3 defocus(vec2 uv, float radius) {
  const float GA = 2.39996323;
  float c = cos(GA), s = sin(GA);
  mat2 turn = mat2(c, s, -s, c);

  vec2 aspectPx = vec2(0.0022 * iResolution.y / iResolution.x, 0.0022);
  vec2 offset = vec2(0.0, radius);
  float r = 1.0;

  vec3 acc = vec3(0.0);
  const int N = 48;
  for (int i = 0; i < N; i++) {
    r += 1.0 / r;
    offset = turn * offset;
    acc += src(uv + aspectPx * (r - 1.0) * offset).rgb;
  }
  return acc / float(N);
}

// Threshold bloom. Sample a disk around the pixel, keep only what is already
// bright, and add it back. Technique from reference/10-sync-cord.md.
//
// Two details make it work at this sample count:
//   * QUADRATIC radius growth (r = t*t). Samples bunch near the centre where the
//     halo is dense and still reach far out for the wide falloff, so a couple of
//     dozen taps cover a radius that would need hundreds if spaced evenly.
//   * A SMALL angular jitter. The reference randomises the pattern hard, which
//     is free for it because its image is already path-traced noise. Ours is
//     clean, so full jitter at this sample count produced heavy speckle across
//     the whole frame — the variance between neighbouring pixels' sample sets
//     became the dominant signal. Jittering only the angle, and only slightly,
//     breaks up the spokes without turning the bloom into noise.
//
// The smoothstep threshold is what keeps it a bloom rather than a blur: only
// pixels already near white contribute, so the dark wall stays dark. It has to
// sit high here — a wall of bright glyphs means a low threshold makes nearly
// every pixel a contributor, which is both noisy and washed out.
vec3 bloom(vec2 uv, float amount) {
  float aspect = iResolution.x / iResolution.y;

  // Angular offset only, and small. Radius stays deterministic.
  float jitter = hash21(uv * iResolution + fract(iTime) * 137.0) * 0.6;

  vec3 acc = vec3(0.0);
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float a = fi * 2.39996323 + jitter;     // golden angle: no spokes
    float t = (fi + 0.5) / float(N);
    float r = t * t * 0.075;                // quadratic: dense core, long reach

    vec2 o = vec2(cos(a), sin(a)) * r;
    o.x /= aspect;

    vec3 c = src(uv + o).rgb;
    acc += c * smoothstep(0.78, 1.0, dot(c, vec3(0.3333)));
  }
  return acc * (amount * 3.0 / float(N));
}

vec4 fx(vec2 uv) {
  vec2 px = 1.0 / iResolution;

  // Focus comes from the alpha the last effect wrote: 1 = sharp, 0 = max blur.
  float focus = src(uv).a;
  float radius = (1.0 - clamp(focus, 0.0, 1.0)) * uDof;

  vec3 col;
  if (radius > 0.001) {
    col = defocus(uv, radius);           // blurring already anti-aliases
  } else {
    col = (uFxaa > 0.5) ? fxaa(uv, px) : src(uv).rgb;
  }

  // Bloom before grain, so the grain sits on top of the glow rather than being
  // smeared by it.
  if (uBloom > 0.001) col += bloom(uv, uBloom);

  // Film grain. Multiplicative, reseeded each frame via fract(iTime) so it
  // crawls instead of sitting as a fixed pattern.
  if (uGrain > 0.001) {
    float n = hash21(uv * iResolution + fract(iTime) * 1000.0);
    col *= mix(1.0, 0.80 + 0.40 * n, uGrain);
  }

  // Tone curve last — it is the transition from working range to display range,
  // so anything that adds light has to happen before it.
  if (uTone > 0.001) col = mix(col, acesApprox(col), uTone);

  return vec4(col, 1.0);
}
