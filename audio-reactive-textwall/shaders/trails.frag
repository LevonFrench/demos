// TRAILS — temporal feedback. Blends this frame with the last presented one, so
// movement leaves a decaying wake.
//
// Technique from reference/09-altair-intro.md, whose final line is:
//
//     fragColor = mix(scene, texture(iChannel0, uv), pow(0.0001, iTimeDelta));
//
// The important part is `pow(base, dt)`, not the feedback itself. A fixed blend
// like mix(new, old, 0.9) ties the trail length to the framerate: at 120fps it
// decays twice as fast in wall-clock terms as at 60fps, so the look changes with
// the machine. Raising a per-second base to the power of dt makes the decay rate
// constant in real time — same trail on any hardware, and correct through frame
// hitches too.
//
// Same reasoning as the exp(-dt*k) smoothing used throughout src/*.js; this is
// its shader-side equivalent.

vec4 fx(vec2 uv) {
  vec3 current = src(uv).rgb;

  if (uTrails < 0.001) return vec4(current, src(uv).a);

  vec3 history = texture(uHist, uv).rgb;

  // uTrails is a TIME CONSTANT in seconds — how long a streak takes to fade to
  // ~37%. Framerate independence still comes from putting dt in the exponent,
  // exactly as the reference does; only the parameterisation differs.
  //
  // The reference writes pow(0.0001, dt), i.e. base = "fraction surviving one
  // second". That reads as a small number for a SHORT trail, which is deeply
  // unintuitive on a slider: exposing base directly made 0.85 mean a six-second
  // tail, so the buffer took six seconds to charge and the screen looked black.
  // tau = -1/ln(base), so this is the same maths the other way round.
  float tau = max(uTrails * 1.2, 0.001);
  float keep = exp(-uDt / tau);

  // Straight leaky integrator, nothing more. An earlier version also took
  // max(col, history * k) to make highlights streak harder — it blows out. The
  // mix converges (a static image decays to itself), but a max against history
  // has no restoring force, so every frame can only ever raise the value and the
  // buffer saturates to white within seconds. If highlight streaking is wanted,
  // it has to come from a term that still decays.
  vec3 col = mix(current, history, keep);

  return vec4(col, src(uv).a);
}
