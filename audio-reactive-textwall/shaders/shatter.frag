// SHATTER — the wall becomes a pane of glass. Voronoi cells act as shards that
// separate along their seams, tilt, and catch light on the cracks.
//
// Different geometry from BLOW AWAY on purpose: irregular Voronoi shards rather
// than the rigid word grid, and they part along seams instead of flying off.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 p = uv * vec2(aspect, 1.0);

  // Shard count across the frame. Kept low deliberately — a shard has to be big
  // enough to carry readable fragments of a word, or it just reads as noise.
  float density = 13.0;
  vec2 gp = p * density;
  vec2 gi = floor(gp);
  vec2 gf = fract(gp);

  // Voronoi: nearest and second-nearest, so we get both the cell id and the
  // distance to the seam between shards.
  vec2 bestId = vec2(0.0);
  vec2 bestOff = vec2(0.0);
  float d1 = 8.0;
  float d2 = 8.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 site = g + hash22(gi + g);
      vec2 r = site - gf;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1; d1 = d;
        bestId = gi + g;
        bestOff = r;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }

  float seam = sqrt(d2) - sqrt(d1); // 0 exactly on a crack

  // Each shard drifts along its own outward normal and rotates a little.
  vec2 rnd = hash22(bestId + 3.1);
  vec2 drift = normalize(bestOff + 1e-5) * -1.0;
  // Keep the parting small relative to a shard. Push much past ~0.03 and each
  // shard samples a distant part of the wall, which reads as scrambled noise
  // rather than as one surface breaking apart.
  float mag = (0.004 + rnd.x * 0.014) * (1.0 + uBass * 0.8) * k * k;
  // Small tilt only — past ~0.3rad the glyphs inside a shard smear into swirls
  // and the whole thing stops reading as broken text.
  float tilt = (rnd.y - 0.5) * 0.40 * k;

  vec2 centre = uv - bestOff / (density * vec2(aspect, 1.0));
  vec2 local = uv - centre;
  local = rot(local * vec2(aspect, 1.0), -tilt);
  local.x /= aspect;

  vec2 sp = centre + local - drift * mag / vec2(aspect, 1.0);
  vec3 col = src(sp).rgb;

  // Cracks: dark seam with a bright specular edge that widens as it breaks.
  float crackW = 0.012 + 0.05 * k;
  float crack = smoothstep(crackW, 0.0, seam);
  col *= 1.0 - crack * k * 0.9;
  col += vec3(0.7, 0.85, 1.0) * smoothstep(crackW * 1.6, crackW, seam)
       * smoothstep(crackW * 0.4, crackW, seam) * k * (0.6 + uTreble);

  return vec4(col, 1.0);
}
