// SHUTTER — the wall splits into diagonal bands that slide apart in alternating
// directions, opening gaps, then closes back.
//
// Technique from reference/14-fractalscape.md. Its transition builds diagonal
// stripes with fract(uv.x*n - uv.y*skew), takes the parity of each stripe, and
// offsets odd and even stripes in OPPOSITE directions. The counter-motion is the
// whole trick — offset every band the same way and it is just a slide; alternate
// them and the wall appears to part.
//
// Distinct from terminal.frag's ordered reveal: that one thresholds a scalar so
// content appears in sequence. This one physically displaces bands that remain
// present throughout, so it reads as a mechanism rather than as drawing.

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  // Band count tied to the type size so bands stay proportionate to the words.
  float bands = clamp(1.0 / max(uCell.y, 0.02) * 0.55, 5.0, 26.0);

  // Skew grows with progress, so the bands start square and lean as they open.
  float skew = 1.6 * k;
  float s = uv.x * bands - uv.y * bands * skew;

  float parity = step(0.5, fract(s));
  float dir = parity * 2.0 - 1.0;

  // Slide, with a kick on the beat so the mechanism snaps rather than glides.
  float slide = k * k * (0.42 + uBass * 0.18) + uBeat * 0.03 * k;

  vec2 p = uv + vec2(0.0, dir * slide);

  // Anything slid past the frame edge is gone — that is what makes the gaps.
  bool gone = p.y < 0.0 || p.y > 1.0;
  vec3 col = gone ? vec3(0.0) : src(p).rgb;

  // Leading edge of each band catches light.
  float edge = abs(fract(s) - 0.5) * 2.0;
  float lip = smoothstep(0.86, 1.0, edge);
  float mask = max(col.r, max(col.g, col.b));
  col += vec3(0.55, 0.72, 1.0) * lip * k * (0.35 + mask * 0.9) * (0.6 + uTreble);

  // Slight darkening into the seam so bands read as separate plates.
  col *= 1.0 - smoothstep(0.90, 1.0, edge) * 0.45 * k;

  // No defocus request. Every band slides at the same rate, so an alpha derived
  // from `slide` is constant across the frame and blurs the whole image rather
  // than the moving parts — the convention is only useful when the value varies
  // spatially (as in explode's shockwave band).
  return vec4(col, 1.0);
}
