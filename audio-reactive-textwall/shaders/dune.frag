// DUNE — the wall turns to sand. Ripples rake across the surface, the glyphs
// emboss out of it as raised relief, and a low sun lights the whole thing.
//
// Technique from reference/03-desert-sand.frag. Almost all of that shader is 3D
// scaffolding we cannot use — raymarcher, dune heightmap, sky, soft shadows,
// volumetric dust. But its sand *texture* function is already pure 2D, and that
// is the part worth having:
//
//   grad()   repeat triangle wave -> smoothed, slightly peaked gradient lines
//   sandL()  two of those, rotated a few degrees apart, each perturbed by
//            gradient noise, screen-blended via a transcendental mixer
//   sand()   two sandL layers at different rotation and frequency, mixed by
//            an underlying noise layer
//
// The second borrowing is function-based bump mapping: sample a scalar field at
// small offsets, build a gradient, and light it. That is what earns this effect
// its place — it is the only one here that produces a *lit surface* rather than
// a displacement or an additive glow, so it reads as a completely different
// material from the other ten.
//
// Our addition: the glyph mask is summed into the height field, so the type is
// raised relief in the sand and gets lit by the same normal, rather than being
// composited over a sand image.

// Repeat gradient lines. Triangle wave, smoothed two ways and mixed, which keeps
// the crests slightly sharp instead of fully sinusoidal.
float ridge(float x, float offs) {
  x = abs(fract(x / 6.283 + offs - 0.25) - 0.5) * 2.0;
  float peaked = clamp(x * x * (-1.0 + 2.0 * x), 0.0, 1.0);
  float smooth_ = smoothstep(0.0, 1.0, x);
  return mix(smooth_, peaked, 0.15);
}

// One sand layer: two rake directions, screen-blended.
float sandLayer(vec2 p) {
  vec2 q = rot(p, 3.14159 / 18.0);
  q.y += (vnoise(q * 18.0) - 0.5) * 0.05;   // waver the lines
  float g1 = ridge(q.y * 80.0, 0.0);

  q = rot(p, -3.14159 / 20.0);              // back the other way, slightly
  q.y += (vnoise(q * 12.0) - 0.5) * 0.05;
  float g2 = ridge(q.y * 80.0, 0.5);

  // Transcendental mixer rather than noise — cheaper here and gives a more
  // directional weave than a noise blend does.
  q = rot(p, 3.14159 / 4.0);
  float a2 = dot(sin(q * 12.0 - cos(q.yx * 12.0)), vec2(0.25)) + 0.5;
  float a1 = 1.0 - a2;

  return 1.0 - (1.0 - g1 * a1) * (1.0 - g2 * a2); // screen blend
}

float sandField(vec2 p) {
  p = vec2(p.y - p.x, p.x + p.y) * 0.7071 / 4.0; // 45 deg, zoomed out
  float c1 = sandLayer(p);
  float c2 = sandLayer(rot(p, 3.14159 / 12.0) * 1.25);
  return mix(c1, c2, smoothstep(0.1, 0.9, vnoise(p * 4.0)));
}

// Combined height: sand ripples plus the type as raised relief.
float height(vec2 uv, float aspect, float rip, float emb) {
  vec2 p = uv * vec2(aspect, 1.0);
  float h = sandField(p * 26.0) * rip;
  h += max(src(uv).r, max(src(uv).g, src(uv).b)) * emb;
  return h;
}

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec3 base = src(uv).rgb;

  // Ripple depth breathes with the low end; relief height stays steadier so the
  // words remain readable while the sand around them moves.
  float rip = 0.055 + uBass * 0.045;
  float emb = 0.16;

  // Bump mapping: central differences on the height field give the gradient.
  vec2 e = vec2(1.6 / iResolution.y, 0.0);
  float hC = height(uv, aspect, rip, emb);
  float hX = height(uv + e.xy, aspect, rip, emb) - height(uv - e.xy, aspect, rip, emb);
  float hY = height(uv + e.yx, aspect, rip, emb) - height(uv - e.yx, aspect, rip, emb);

  // Surface normal of the relief. The 2*e.x scaling keeps slope independent of
  // resolution, which matters because e is derived from iResolution.
  vec3 n = normalize(vec3(-hX / (2.0 * e.x), -hY / (2.0 * e.x), 1.0));

  // Low sun, swinging slowly. Locked to the bar when we have a tempo.
  float az = mix(iTime * 0.15, uBar * 6.283, uLocked) + 2.2;
  vec3 ld = normalize(vec3(cos(az) * 0.85, sin(az) * 0.85, 0.62));
  vec3 vd = vec3(0.0, 0.0, 1.0);

  float dif = max(dot(n, ld), 0.0);
  float spe = pow(max(dot(reflect(-ld, n), vd), 0.0), 12.0);
  float fre = pow(1.0 - max(n.z, 0.0), 3.0);

  // Sand colour, grain from two noise octaves.
  vec3 sand = mix(vec3(0.98, 0.90, 0.68), vec3(0.80, 0.52, 0.31), fbm(uv * vec2(aspect, 1.0) * 9.0));
  sand = mix(sand * 1.25, sand * 0.62, fbm(uv * vec2(aspect, 1.0) * 30.0));

  // Crevice shading straight from the height — cheap ambient occlusion.
  sand *= 0.55 + hC / max(rip + emb, 1e-4) * 0.55;

  vec3 col = sand * (dif * 1.15 + 0.28) + vec3(1.0, 0.94, 0.82) * spe * 0.55 * (0.4 + uTreble);
  col += vec3(1.0, 0.72, 0.42) * fre * 0.12;

  // Keep a trace of the wall's own colour in the raised type so it does not read
  // as an unrelated sand image that happens to be word-shaped.
  float mask = max(base.r, max(base.g, base.b));
  col = mix(col, col * 0.7 + base * 0.6, mask * 0.35);

  return vec4(mix(base, col, k), 1.0);
}
