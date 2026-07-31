// ADVECT — the wall is carried by the fluid simulation.
//
// This is the payoff for fluid.frag holding persistent state. Every other effect
// here computes its displacement fresh from uniforms each frame, which means the
// wall can only ever be a function of *now*. This one reads a field that
// remembers: push it with the cursor and the motion keeps travelling after you
// stop, curls back on itself, and slowly dies.
//
// Compare `liquid.frag`, which domain-warps with fbm. That looks fluid-ish but
// has no memory and no momentum — it cannot be disturbed, only animated.

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  vec4 f = texture(uSim, uv);
  vec2 vel = f.xy;

  // Follow the flow backwards, exactly as the simulation advects itself.
  vec2 p = uv - vel * uTexel * k * 6.0;

  // Chromatic separation along the flow direction, scaled by speed, so fast
  // regions smear into colour and still regions stay clean.
  float speed = length(vel);
  vec2 dir = vel / max(speed, 1e-5);
  float sep = min(speed * 0.0016, 0.010) * k;

  vec3 col;
  col.r = src(p + dir * sep).r;
  col.g = src(p).g;
  col.b = src(p - dir * sep).b;

  // Dye carried by the fluid, tinted by direction of travel so opposing currents
  // read as different colours rather than one uniform wash.
  float hue = atan(dir.y, dir.x);
  vec3 dye = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + hue + iTime * 0.2);
  col += dye * f.w * k * (0.30 + uLevel * 0.5);

  // Shear highlight: bright where the flow is stretching the wall hardest.
  float shear = clamp(speed * 0.10, 0.0, 1.0);
  col += vec3(0.45, 0.65, 1.0) * shear * k * 0.22 * max(col.r, max(col.g, col.b));

  return vec4(col, 1.0 - shear * 0.35 * k);  // fast flow requests defocus
}
