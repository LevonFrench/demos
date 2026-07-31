// TERMINAL — the wall types itself on in reading order behind a phosphor
// cursor, then un-types on release. Scanlines, bloom, vignette.
//
// Technique from reference/05-stroke-font.md. That shader draws letters as line
// segments and reveals them with a global counter: every segment increments it,
// and once it passes a time-scaled threshold the remaining segments return zero.
// The text writes itself for free, because the draw order *is* the reveal order.
//
// We cannot use that literally — it depends on knowing the strokes, and our
// glyphs are a rastered texture with no primitives to count. The transferable
// idea is the ordering: replace "index of this segment" with a scalar computed
// per pixel that increases in reading order, then threshold it against progress.
// Same effect, no primitives required:
//
//   segment index / total   ->   (row + column fraction) / rows
//
// Also taken: two-tier ink (one distance, a sharp core and a soft halo from it),
// the sin(fragCoord.y) phosphor banding, and the compact vignette
// pow(k*x*y*(1-x)*(1-y), e).

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  vec3 base = src(uv).rgb;
  float mask = max(base.r, max(base.g, base.b));

  // Reading order. Texture is Y-flipped, so 1.0 - uv.y counts rows from the top.
  float rows = max(1.0 / max(uCell.y, 1e-4), 1.0);
  float row = floor((1.0 - uv.y) / max(uCell.y, 1e-4));
  float order = (row + uv.x) / rows;

  // The reveal front. Negative once this pixel has been typed.
  float front = order - k * 1.05;
  float ink = smoothstep(0.010, -0.004, front);

  // Cursor: a hot bar sitting exactly on the front.
  float cursor = exp(-abs(front) * 420.0);

  // Two-tier glow from the glyph coverage — sharp core plus a soft halo, both
  // derived from the same source, as the reference does from one distance.
  float halo = 0.0;
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float a = float(i) * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * 0.006;
    o.x /= iResolution.x / iResolution.y;
    halo = max(halo, max(src(uv + o).r, max(src(uv + o).g, src(uv + o).b)));
  }

  // Phosphor. Green-cyan core, cooler bloom.
  vec3 phos = vec3(0.35, 1.0, 0.72) * mask;
  phos += vec3(0.12, 0.55, 0.45) * halo * (0.45 + uLevel * 0.7);

  // Horizontal shimmer and slow vertical banding, straight from the reference's
  // colour term — cheap, and it does most of the work selling "CRT".
  float band = 0.86 + 0.14 * sin(uv.y * 3.14159 * 2.2 + iTime * 1.7);
  float shimmer = 0.80 + 0.20 * sin(uv.x * 3.14159 * 0.5 - iTime * 4.3);
  phos *= band * shimmer;

  // Scanlines, pitched to the real pixel grid.
  float scan = 0.72 + 0.28 * sin(uv.y * iResolution.y * 3.14159);
  phos *= scan;

  vec3 col = mix(base, phos, ink);

  // Cursor bar rides above everything, brightest on the beat.
  col += vec3(0.55, 1.0, 0.80) * cursor * k * (0.7 + uBeat * 0.9);

  // Compact vignette: peaks at 1/16 in the centre, so scale and take a low power
  // to keep it subtle.
  float vig = pow(clamp(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.0, 1.0), 0.18);
  col *= mix(1.0, vig, ink);

  return vec4(col, 1.0);
}
