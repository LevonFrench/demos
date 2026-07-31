// Pass 0 — always on. Turns the white-on-black wall into the resting look.
//
// Deliberately has NO centre-origin motion: nothing scales about the middle and
// nothing radiates outward from it. Reaction is distributed per row so the wall
// reads as a flat surface reacting everywhere at once. All motion is gated by
// uPulse (0 = dead still), so the wall can sit perfectly static if you want it.
vec4 fx(vec2 uv) {
  float row = floor(uv.y / max(uCell.y, 1e-4));
  float rnd = hash11(row);

  // Per-row lateral push. Rows lag each other so the whole wall never moves as
  // one block, and there is no origin for it to emanate from.
  float lag = fract(rnd * 3.17);
  float drive = mix(uBass, uLevel, lag);
  float dirSign = rnd > 0.5 ? 1.0 : -1.0;
  float shove = dirSign * drive * uCell.x * 0.22 * uPulse;

  // Beat-locked drift. uScroll is in cells and advances off the detected tempo,
  // so one unit is exactly one word: the wall slides in time with the track
  // rather than at some arbitrary pixel rate.
  //
  // Every row moves TOGETHER. The first version used the per-row dirSign, so
  // rows drifted apart at random and the wall lost its alignment within seconds
  // — the text stopped reading across and just looked chopped. Rows keep their
  // half-cell brick offset relative to each other; only the whole thing
  // translates. Still not a "pulse": constant velocity, no origin, no return.
  float drift = uScroll * uCell.x;

  // Very slight vertical settle, again per row, not per screen.
  float settle = sin(iTime * 1.7 + rnd * 6.28) * uCell.y * 0.05 * uBass * uPulse;

  vec2 p = uv + vec2(shove + drift, settle);

  // Chromatic split on a fixed horizontal axis — uniform across the frame.
  // srcWrap, not src: the drift above is unbounded, and src() blacks out
  // anything off the unit square. The wall texture tiles exactly (textwall.js
  // snaps the cell so a whole number spans the canvas), so wrapping is seamless.
  float ab = (0.0012 + uTreble * 0.0035 + uBeat * 0.0025) * uPulse;
  float r = srcWrap(p + vec2(ab, 0.0)).r;
  float g = srcWrap(p).g;
  float b = srcWrap(p - vec2(ab, 0.0)).b;
  float mask = max(r, max(g, b));

  // Colour still reacts even with motion off — that part is not a "pulse".
  vec3 cool = vec3(0.66, 0.76, 1.00);
  vec3 hot  = vec3(1.00, 0.26, 0.52);
  float heat = clamp(uBeat * 0.7 + drive * 0.5, 0.0, 1.0);
  vec3 tint = mix(cool, hot, heat);

  vec3 col = vec3(r, g, b) * tint;

  // Flat, even bloom on the glyphs themselves. No radial falloff.
  col += tint * mask * (0.10 + uLevel * 0.35);

  return vec4(col, 1.0);
}
