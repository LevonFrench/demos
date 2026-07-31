// FLUID — the simulation step. Not an effect: this runs every frame before the
// effect chain and maintains persistent state that advect.frag consumes.
//
// Technique from reference/12-fluid-particles.md. Two classic pieces:
//
//   1. Semi-Lagrangian advection. Rather than pushing values forward (which
//      scatters, and needs somewhere to put collisions), look BACKWARD along the
//      velocity to where this parcel came from and sample there. Gather instead
//      of scatter — unconditionally stable, and one texture fetch.
//   2. Pressure relaxation. Each step nudges velocity down the local pressure
//      gradient and rebuilds pressure from the neighbourhood minus divergence.
//      One Jacobi iteration per frame; over successive frames it converges,
//      which is what stops the field either compressing to nothing or blowing up.
//
// State layout, in the RGBA16F sim buffer:
//   xy = velocity in pixels/frame
//   z  = pressure
//   w  = dye, for visualisation
//
// Half-float is not optional here. The buffer feeds its own output back in every
// frame, so 8-bit quantisation error compounds and the field dies within a
// second or two.

vec4 fx(vec2 uv) {
  // src() reads the previous simulation state.
  vec4 here = src(uv);

  // --- advection: gather from where this parcel came from ---------------
  vec2 back = uv - here.xy * uTexel;
  vec4 q = src(back);

  // --- pressure relaxation over the 4-neighbourhood ---------------------
  vec4 nR = src(uv + vec2(uTexel.x, 0.0));
  vec4 nL = src(uv - vec2(uTexel.x, 0.0));
  vec4 nU = src(uv + vec2(0.0, uTexel.y));
  vec4 nD = src(uv - vec2(0.0, uTexel.y));

  float pressure = (nR.z + nL.z + nU.z + nD.z) * 0.25;

  // Velocity follows the negative pressure gradient.
  vec2 grad = vec2(nR.z - nL.z, nU.z - nD.z) * 0.5;
  q.xy -= grad * 0.9;

  // Divergence of the velocity field: what pressure has to cancel out.
  float div = ((nR.x - nL.x) + (nU.y - nD.y)) * 0.5;
  q.z = pressure - div * 0.7;

  // --- injection --------------------------------------------------------
  float aspect = iResolution.x / iResolution.y;

  // Cursor drags the fluid. Using the smoothed pointer velocity rather than a
  // raw frame delta keeps a fast flick from injecting one enormous spike.
  if (uCursor > 0.5) {
    vec2 d = (uv - uMouse) * vec2(aspect, 1.0);
    float reach = 0.09;
    float w = smoothstep(reach, 0.0, length(d));
    q.xy += uMouseVel * w * 5.0 * uFluid;
    q.w += w * (0.35 + uMouseDown * 0.65) * uFluid;
  }

  // Beat impulse: a radial kick at the effect origin, so the fluid responds to
  // the track rather than only to the pointer.
  vec2 od = (uv - uOrigin) * vec2(aspect, 1.0);
  float ol = length(od);
  float kick = smoothstep(0.16, 0.0, ol) * uBeat * uFluid;
  q.xy += normalize(od + 1e-5) * kick * 12.0;
  q.w += kick * 0.6;

  // Ambient swirl driven by the low end, so it never sits perfectly still.
  float t = iTime * 0.25;
  vec2 swirl = vec2(sin(uv.y * 9.0 + t), cos(uv.x * 11.0 - t));
  q.xy += swirl * uBass * 0.35 * uFluid;

  // --- damping and limits ------------------------------------------------
  q.xy *= 0.985;   // viscosity; without it energy accumulates and never leaves
  q.z *= 0.96;
  q.w *= 0.985;

  // Hard clamp. A single NaN or runaway texel would advect outward and poison
  // the whole field within a few frames, and there is no way to recover once it
  // spreads — cheaper to bound it than to detect it.
  q.xy = clamp(q.xy, vec2(-14.0), vec2(14.0));
  q.z = clamp(q.z, -6.0, 6.0);
  q.w = clamp(q.w, 0.0, 3.0);

  // --- boundaries ---------------------------------------------------------
  // No flow through the frame edge, or the field drifts and pins to one side.
  vec2 edge = min(uv, 1.0 - uv);
  if (edge.x < uTexel.x * 2.0 || edge.y < uTexel.y * 2.0) q.xy = vec2(0.0);

  // First frame: start from rest, not from uninitialised memory.
  if (iTime < 0.05) q = vec4(0.0);

  return q;
}
