// PARTICLES — one particle per pixel, advected by mass-weighted reintegration.
//
// State layout, in an RGBA16F buffer:
//   xy = sub-cell offset from this cell's centre, in sim pixels
//   zw = velocity, in sim pixels per step
//
// THE IDEA: reintegration.
//
// The obvious way to move particles is to push each one forward and write it
// wherever it lands. A fragment shader cannot do that — it only writes its own
// pixel. So invert it: each cell asks "of all the particles near me, how much of
// each one lands inside me this step?", and takes the mass-weighted average of
// those contributions as its new particle.
//
// Because every cell claims a share by weight, and the weights of a particle
// across all destination cells sum to (near) one, mass is conserved rather than
// leaking — which is what stops the field slowly evaporating or piling up. That
// is the property the reference is demonstrating.
//
// NOTE ON FIDELITY: the reference's own Reintegration/Simulation functions were
// not available (its Common tab was truncated before them), so this is an
// implementation of the described technique, not a port of that code. Known
// simplifications: fixed particle mass, and no second material channel, because
// four half-float components hold offset and velocity and nothing more. See
// .wiki/wiki/concepts/particle-reintegration.md.

vec4 fx(vec2 uv) {
  vec2 R = 1.0 / uPTexel;
  vec2 here = floor(uv * R) + 0.5;

  float dt = 1.0;

  vec2 accX = vec2(0.0);
  vec2 accV = vec2(0.0);
  float accM = 0.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nc = here + vec2(float(i), float(j));
      vec4 pa = texture(uPart, nc * uPTexel);

      vec2 x = nc + pa.xy;
      vec2 v = pa.zw;
      vec2 x2 = x + v * dt;              // where it lands this step

      vec2 d = x2 - here;
      float w = exp(-dot(d, d) * 2.0);   // share of it that lands in this cell

      accM += w;
      accX += x2 * w;
      accV += v * w;
    }
  }

  vec2 offset, vel;

  if (accM < 1e-4) {
    // Nothing reached this cell. Respawn at rest rather than leaving a hole —
    // the grid must stay fully populated or the density field develops permanent
    // dead pixels that the pressure term then pulls everything into.
    offset = vec2(0.0);
    vel = vec2(0.0);
  } else {
    offset = accX / accM - here;
    vel = accV / accM;
  }

  // --- forces ------------------------------------------------------------
  vec4 dens = texture(uDens, here * uPTexel);

  // Pressure: push down the density gradient, away from crowding.
  float dR = texture(uDens, (here + vec2(1.0, 0.0)) * uPTexel).x;
  float dL = texture(uDens, (here - vec2(1.0, 0.0)) * uPTexel).x;
  float dU = texture(uDens, (here + vec2(0.0, 1.0)) * uPTexel).x;
  float dD = texture(uDens, (here - vec2(0.0, 1.0)) * uPTexel).x;
  vec2 gradRho = vec2(dR - dL, dU - dD) * 0.5;
  vel -= gradRho * 0.34;

  // Viscosity: pull toward the local mean velocity, or neighbouring particles
  // pass straight through each other and it reads as sand, not liquid.
  vec2 meanV = dens.yz / max(dens.x, 1e-4);
  vel = mix(vel, meanV, 0.22);

  float aspect = iResolution.x / iResolution.y;
  vec2 p01 = here * uPTexel;

  // Cursor stirs.
  if (uCursor > 0.5) {
    vec2 d = (p01 - uMouse) * vec2(aspect, 1.0);
    float w = smoothstep(0.10, 0.0, length(d));
    vel += uMouseVel * w * 3.0 * uFluid;
  }

  // Beat impulse at the effect origin.
  vec2 od = (p01 - uOrigin) * vec2(aspect, 1.0);
  float kick = smoothstep(0.18, 0.0, length(od)) * uBeat * uFluid;
  vel += normalize(od + 1e-5) * kick * 3.0;

  // Slow ambient churn on the low end so it never fully settles.
  float t = iTime * 0.2;
  vel += vec2(sin(p01.y * 8.0 + t), cos(p01.x * 10.0 - t)) * uBass * 0.10 * uFluid;

  // --- limits and boundaries --------------------------------------------
  vel *= 0.985;
  vel = clamp(vel, vec2(-2.5), vec2(2.5));

  // Reflect at the frame edge, and damp, so momentum does not pile into corners.
  vec2 pos = here + offset;
  if (pos.x < 1.5) { vel.x = abs(vel.x) * 0.5; }
  if (pos.y < 1.5) { vel.y = abs(vel.y) * 0.5; }
  if (pos.x > R.x - 1.5) { vel.x = -abs(vel.x) * 0.5; }
  if (pos.y > R.y - 1.5) { vel.y = -abs(vel.y) * 0.5; }

  // The offset must stay sub-cell, or a particle escapes the 3x3 gather window
  // in density.frag and its mass silently vanishes.
  offset = clamp(offset, vec2(-0.9), vec2(0.9));

  if (iTime < 0.05) { offset = vec2(0.0); vel = vec2(0.0); }

  return vec4(offset, vel);
}
