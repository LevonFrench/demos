// BLOW AWAY — each word cell is a rigid body caught in a gust: it translates,
// spins and tumbles off-screen, then flies back to its slot.
//
// Inverse mapping: for the pixel we are shading we can't know which cell landed
// here, so we test the 3x3 neighbourhood of candidate cells, undo each one's
// motion, and keep the hit that still falls inside its own cell.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float ease = k * k;                    // accelerate outward
  float gust = 1.0 + uBass * 1.2;

  vec3 acc = vec3(0.0);
  float hits = 0.0;

  vec2 base = floor(uv / uCell);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = base + vec2(float(i), float(j));
      vec2 rnd = hash22(id);
      float spin = (hash21(id + 7.7) - 0.5) * 6.0;

      // Mostly rightward + upward drift, heavily jittered per cell.
      vec2 dir = normalize(vec2(0.75 + rnd.x * 0.6, (rnd.y - 0.4) * 0.9));
      float speed = (0.35 + rnd.x * 1.1) * gust;
      vec2 offset = dir * speed * ease;

      // Undo the translation, then the rotation about the cell centre.
      vec2 cellMin = id * uCell;
      vec2 local = uv - offset - cellMin;
      vec2 c = local / uCell - 0.5;
      c = rot(c * vec2(uCell.x / uCell.y, 1.0), -spin * ease);
      c.x /= uCell.x / uCell.y;
      local = (c + 0.5) * uCell;

      // Did this pixel actually come from that cell?
      if (local.x < 0.0 || local.x > uCell.x || local.y < 0.0 || local.y > uCell.y) continue;

      vec2 srcUv = cellMin + local;
      float fade = 1.0 - smoothstep(0.55, 1.0, ease * (0.6 + rnd.y * 0.8));
      acc += src(srcUv).rgb * fade;
      hits += 1.0;
    }
  }

  if (hits < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);

  // Motion smear in the gust direction.
  vec3 col = acc;
  col += src(uv - vec2(0.02, 0.0) * ease).rgb * 0.18 * k;

  // Alpha = focus. Cells that have travelled furthest go soft, so the gust
  // reads as speed rather than as a clean slide. See the prelude for the
  // convention; post.frag turns this into a blur radius.
  float focus = 1.0 - ease * 0.85;

  return vec4(col, focus);
}
