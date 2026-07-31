// NEON — the wall becomes bent glass tubing: hot core, inverse-square halo,
// a glow that breathes on scrolling noise, and an LED grid the light sits behind.
//
// Technique from reference/02-sdf-neon-clock.frag. That shader gets neon almost
// free, because it builds its glyphs analytically and therefore already knows
// the exact distance to the nearest stroke — `shade = 0.004 / dist` does the
// rest. We do not have that. Our glyphs are a rastered texture with no distance
// information at all, only coverage.
//
// So the distance has to be recovered before the technique can be applied: a
// golden-angle spiral of taps outward from each pixel, keeping the radius of the
// nearest lit texel. Roughly a jump-flood in miniature, cheap enough per frame,
// and accurate enough that 1/d behaves the way it does in the original.
//
// The other two borrowings port directly, since neither depends on knowing the
// geometry: noise-scrolled glow modulation, and the mod()-based grid overlay.

#define TAPS 24
#define MAX_R 0.055

float lum(vec3 c) { return max(c.r, max(c.g, c.b)); }

// Radius to the nearest lit texel, in aspect-corrected UV. Returns MAX_R when
// nothing is found, which reads as "far away" and kills the glow smoothly.
float glyphDist(vec2 uv, float aspect) {
  if (lum(src(uv).rgb) > 0.35) return 0.0; // already inside the stroke
  float best = MAX_R;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i);
    // Golden-angle spiral: even coverage without a square grid's directional bias.
    float a = fi * 2.39996323;
    float r = MAX_R * sqrt((fi + 0.5) / float(TAPS));
    vec2 o = vec2(cos(a), sin(a)) * r;
    o.x /= aspect;
    if (lum(src(uv + o).rgb) > 0.35) best = min(best, r);
  }
  return best;
}

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec3 base = src(uv).rgb;

  float d = glyphDist(uv, aspect);

  // The core relation. Epsilon keeps the tube from blowing out to pure white.
  float shade = 0.0022 / (d + 0.0016);

  // Glow pulse: scrolling noise, pushed by the mids so the tube flickers with
  // the track rather than on a fixed clock.
  float n = vnoise((uv + vec2(iTime * 0.09, iTime * 0.05)) * 7.0);
  shade *= 0.55 + n * (0.55 + uMid * 0.9);

  // Beat flare — a short lift on each transient.
  shade *= 1.0 + uBeat * 0.7;

  // Tube colour: hot core running to a saturated halo.
  vec3 tube = vec3(1.00, 0.28, 0.62);
  vec3 halo = vec3(0.30, 0.55, 1.00);
  vec3 col = mix(halo, tube, smoothstep(0.02, 0.0, d)) * shade;

  // Blown-out core where the stroke actually is.
  col += vec3(1.0) * smoothstep(0.004, 0.0, d) * (0.5 + uLevel * 0.5);

  // LED grid the light sits behind. Cell size tracks the type so it stays
  // proportionate when the font size changes.
  float cells = clamp(1.0 / max(uCell.y, 0.004), 40.0, 400.0);
  vec2 g = abs(fract(uv * vec2(cells * aspect, cells)) - 0.5);
  float grid = 0.5 - max(g.x, g.y);
  float gridMask = 0.35 + smoothstep(0.0, 2.5 / iResolution.y * cells, grid) * 0.65;
  col *= gridMask;

  // Fade in from the untouched wall so uProgress == 0 is a true no-op.
  return vec4(mix(base, col, k), 1.0);
}
