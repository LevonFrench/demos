// EXPLODE — a shockwave leaves the centre, drags the wall radially outward,
// blows the channels apart and burns the leading edge. Reverses by imploding.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  // Seeded per fire, so the blast never comes from the middle twice running.
  vec2 c = (uv - uOrigin) * vec2(aspect, 1.0);
  float d = length(c);
  vec2 dir = c / max(d, 1e-5);

  // Ring position sweeps out with progress; blast strength rides the bass.
  float ring = k * 1.15;
  float w = 0.10 + 0.06 * k;
  float band = exp(-pow((d - ring) / w, 2.0));

  float force = (0.16 + uBass * 0.20) * k;
  float push = band * force + k * k * d * 0.35;

  vec2 off = dir * push / vec2(aspect, 1.0);

  // Chromatic blast — channels separate hard at the ring.
  float sep = (0.006 + uTreble * 0.01) * (band * 3.0 + k);
  vec3 col;
  col.r = src(uv - off * 1.06 - dir * sep).r;
  col.g = src(uv - off).g;
  col.b = src(uv - off * 0.94 + dir * sep).b;

  // Incandescent shell + heat haze in front of it.
  vec3 fire = mix(vec3(1.0, 0.85, 0.35), vec3(1.0, 0.22, 0.05), smoothstep(0.0, 0.6, d));
  col += fire * band * (0.55 + uBeat * 0.6) * (1.0 - smoothstep(0.75, 1.15, k));

  // Everything past the ring is thinning out.
  col *= 1.0 - smoothstep(ring - 0.35, ring + 0.15, d) * k * 0.55;

  // Center flash on ignition.
  col += vec3(1.0) * exp(-d * 9.0) * smoothstep(0.0, 0.25, k) * (1.0 - smoothstep(0.25, 0.6, k));

  // Alpha = focus. Defocus hardest right at the shockwave and in the thinning
  // region behind it — the blast front smears, the untouched wall stays sharp.
  float focus = 1.0 - clamp(band * 0.9 + k * 0.35 * smoothstep(ring - 0.3, ring + 0.2, d), 0.0, 0.9);

  return vec4(col, focus);
}
