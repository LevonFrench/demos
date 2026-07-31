// VORTEX — the wall winds into a spiral around uOrigin and unwinds on release.
// Rotation falls off with radius so the outer wall stays legible while the core
// twists into a knot.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 d = (uv - uOrigin) * vec2(aspect, 1.0);
  float dist = length(d);

  // Twist strongest at the centre, easing out to nothing by the edge.
  float reach = 0.85;
  float falloff = smoothstep(reach, 0.0, dist);
  float twist = falloff * falloff * (5.5 + uBass * 4.0) * k;

  // Slight inward pull so it reads as being drawn in, not just rotated.
  float suck = falloff * 0.14 * k * (0.6 + uLevel * 0.6);

  vec2 q = rot(d, -twist) * (1.0 + suck);
  vec2 p = uOrigin + q / vec2(aspect, 1.0);

  // Angular chromatic smear — channels lag around the spiral.
  float lag = falloff * 0.10 * k;
  vec3 col;
  col.r = src(uOrigin + rot(d, -twist + lag) * (1.0 + suck) / vec2(aspect, 1.0)).r;
  col.g = src(p).g;
  col.b = src(uOrigin + rot(d, -twist - lag) * (1.0 + suck) / vec2(aspect, 1.0)).b;

  // Motion trails along the spiral so the wind-up leaves streaks.
  const int TAPS = 6;
  vec3 trail = vec3(0.0);
  for (int i = 1; i <= TAPS; i++) {
    float f = float(i) / float(TAPS);
    vec2 t = uOrigin + rot(d, -twist * (1.0 - f * 0.35)) * (1.0 + suck) / vec2(aspect, 1.0);
    trail = max(trail, src(t).rgb * (1.0 - f) * 0.55);
  }
  col = max(col, trail * k);

  // Darken the eye of the vortex.
  col *= 1.0 - smoothstep(0.18, 0.0, dist) * k * 0.65;

  return vec4(col, 1.0);
}
