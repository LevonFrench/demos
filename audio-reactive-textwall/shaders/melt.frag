// MELT — columns sag at different rates, letterforms smear downward into drips
// and the pigment pools and darkens. Reversing sucks the drips back up.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  // Per-column drip rate, varied at two scales so it reads organic.
  float colId = floor(uv.x * 140.0);
  float rate = 0.35 + hash11(colId) * 0.9 + vnoise(vec2(colId * 0.07, iTime * 0.05)) * 0.5;

  // Things melt faster the further down they already are (gravity feedback).
  float depth = 1.0 - uv.y;
  float drop = k * k * rate * (0.30 + uBass * 0.22) * (0.45 + depth);

  // Lateral wobble as the material loses its edge.
  float wob = (vnoise(vec2(uv.x * 22.0, uv.y * 6.0 - iTime * 0.4)) - 0.5) * 0.02 * k;

  vec2 p = uv + vec2(wob, drop);

  // Vertical smear: take the brightest sample along the drip so trails persist.
  vec3 col = vec3(0.0);
  const int TAPS = 10;
  for (int i = 0; i < TAPS; i++) {
    float f = float(i) / float(TAPS - 1);
    vec2 q = p - vec2(wob * f, drop * f * 0.85);
    col = max(col, src(q).rgb * (1.0 - f * 0.45));
  }

  // Pooling: pigment thickens and cools toward the bottom of the frame.
  float pool = smoothstep(0.35, 0.0, uv.y) * k;
  col = mix(col, col * vec3(0.55, 0.35, 0.85), pool * 0.8);
  col += vec3(0.25, 0.05, 0.35) * pool * length(col) * 0.6;

  // Surface loses definition as it liquefies.
  col = mix(src(uv).rgb, col, smoothstep(0.0, 0.15, k));

  return vec4(col, 1.0);
}
