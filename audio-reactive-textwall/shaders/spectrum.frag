// SPECTRUM — every column of words becomes its own frequency band. The wall
// turns into an equaliser made of type.
//
// This effect only exists because of the uFFT texture (see prelude). With three
// scalars — bass, mid, treble — an effect can react to the music, but every
// pixel reacts to the *same* number, so the whole wall can only ever move as one
// body. A spectrum texture allows per-pixel frequency addressing, so each column
// can be doing something different at the same instant.
//
// Technique from reference/13-city-flare.md, which reads its spectrum the same
// way to drive scene brightness.

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  vec3 base = src(uv).rgb;

  // One band per word column, so bars line up with the type rather than cutting
  // across it.
  float cols = max(1.0 / max(uCell.x, 1e-4), 1.0);
  float colId = floor(uv.x / max(uCell.x, 1e-4));
  float f = (colId + 0.5) / cols;

  // Perceptual spread — linear bins bunch everything audible into the far left.
  float amp = fft(pow(f, 1.7));

  // Neighbouring bands smooth each other slightly, or adjacent columns jitter
  // independently and it reads as noise rather than as a spectrum.
  amp = mix(amp, (fft(pow(max(f - 1.0 / cols, 0.0), 1.7)) +
                  fft(pow(min(f + 1.0 / cols, 1.0), 1.7))) * 0.5, 0.35);
  amp = clamp(amp * 1.15, 0.0, 1.0);

  // Column rises with its band.
  float lift = amp * 0.10 * k;
  vec3 col = src(uv + vec2(0.0, -lift)).rgb;

  // Bar filling from the bottom to the band's height.
  float barTop = amp * 0.85;
  float inBar = smoothstep(barTop + 0.01, barTop - 0.01, uv.y);
  float capGlow = exp(-abs(uv.y - barTop) * 90.0);

  // Hue walks across the spectrum so the bands are distinguishable.
  vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + f * 5.0 + iTime * 0.15);

  float mask = max(col.r, max(col.g, col.b));
  col += tint * inBar * mask * (0.55 + amp) * k;
  col += tint * capGlow * k * (0.35 + uBeat * 0.5);

  // Columns in quiet bands recede.
  col *= mix(1.0, 0.35 + amp * 1.1, k * 0.8);

  return vec4(mix(base, col, k), 1.0);
}
