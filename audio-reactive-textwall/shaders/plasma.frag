// PLASMA — the glyphs ignite into rolling coloured plasma, sheared by a
// travelling wave, hue cycling on the bar.
//
// Technique from reference/04-cpu-demo.md (see that stub for provenance).
// Three ideas taken, all of them small and general:
//
//   1. Ridged turbulence. Summing abs() of signed noise octaves instead of the
//      noise itself. The abs() creates creases at every zero crossing, which is
//      what gives flame and plasma their filament structure — ordinary fBm is
//      too blobby to read as either.
//   2. Hue from a triangle wave. Three phase-shifted triangle waves clamped to
//      [0,1] give a full rainbow from one scalar, with no branching and no HSV
//      conversion. Then pow(vec3(1-t), hue + 1.5) uses that hue as a per-channel
//      *exponent*, so channels fall off at different rates along the gradient
//      rather than being tinted uniformly. Same trick as the heat ramp in
//      [[kali-glow-fields]], generalised to arbitrary hue.
//   3. Damped-cosine shear. A cosine windowed by a squared falloff makes a
//      localised ripple; two of them at different phases, differenced, shear the
//      image with a travelling wave.
//
// Deliberately NOT taken: the source's radial lens warps (p *= 1/(1-k*length(p))
// and similar) are centre-origin, which this project has ruled out — the resting
// wall must never scale or radiate from screen centre.

// Three phase-shifted triangle waves -> RGB. One scalar in, a hue out.
vec3 hueTri(float h) {
  return clamp(3.0 * abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 2.0 - 1.0) - 1.0, 0.0, 1.0);
}

// Ridged turbulence: abs() of signed noise, three octaves.
float ridged(vec2 p, float z) {
  float t = abs(vnoise(p + z) * 2.0 - 1.0);
  t += 0.50 * abs(vnoise(p * 2.0 - z * 0.7) * 2.0 - 1.0);
  t += 0.25 * abs(vnoise(p * 4.0 + z * 1.3) * 2.0 - 1.0);
  return t * 0.5;
}

vec3 plasmaAt(vec2 p, float hue, float z) {
  return pow(vec3(1.0 - ridged(p, z)), hueTri(hue) + 1.5);
}

// Damped cosine ripple — a localised wave packet.
float ripplePacket(float g) {
  g = abs(g * 40.0);
  return cos(g) * pow(1.0 - clamp(g / 11.0, 0.0, 1.0), 2.0);
}

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // Travelling-wave shear. Two packets at different phases, differenced, so the
  // distortion sweeps rather than sitting still.
  float wt = iTime * 0.4;
  float shear = 0.02 * (ripplePacket(p.y + cos(wt) * 3.0) - ripplePacket(p.y - cos(wt * 1.1) * 2.0));
  vec2 q = uv + vec2(shear * k * (1.0 + uBass), 0.0);

  vec3 base = src(q).rgb;
  float mask = max(base.r, max(base.g, base.b));

  // Hue advances with the bar when locked, free-running otherwise.
  float hue = mix(iTime * 0.06, uBar, uLocked) + uMid * 0.15;
  float z = iTime * 0.30;

  // Two plasma evaluations at different scale and hue, multiplied — the product
  // is what gives fine filament detail, rather than one soft field.
  vec3 fire = plasmaAt(p * 3.2, hue, z) * plasmaAt(p * 6.7 + 10.0, hue + 0.333, z * 1.1);
  fire *= 2.0 + uBeat * 1.5;

  // The type is the fuel: plasma burns where the glyphs are, fading out away
  // from them so the wall does not just become a full-screen plasma demo.
  float fuel = mask * 1.25 + 0.10;
  vec3 col = base * (1.0 - k * 0.55) + fire * fuel * k;

  // Rim of hotter colour just outside the letterforms.
  float rim = smoothstep(0.05, 0.55, mask) * (1.0 - smoothstep(0.55, 0.95, mask));
  col += hueTri(hue + 0.5) * rim * k * (0.35 + uTreble * 0.8);

  return vec4(col, 1.0);
}
