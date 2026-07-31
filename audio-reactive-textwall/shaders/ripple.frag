// RIPPLE — concentric waves crossing the wall like water struck at uOrigin,
// with a second wavefront running on the beat grid so the rings land on tempo.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 d = (uv - uOrigin) * vec2(aspect, 1.0);
  float dist = length(d);
  vec2 dir = d / max(dist, 1e-5);

  // Primary ring set expanding from the strike point.
  float speed = 1.1 + uBass * 0.5;
  float freq = 34.0;
  float decay = exp(-dist * 2.2);
  float w1 = sin(dist * freq - iTime * speed * 6.0) * decay;

  // Secondary set phase-locked to the tempo — sits still between beats and
  // snaps forward on each one, so it reads as timed rather than continuous.
  float grid = mix(iTime * 2.0, floor(iTime * 2.0) + uPhase, uLocked);
  float w2 = sin(dist * freq * 0.6 - grid * 5.0) * exp(-dist * 1.4) * 0.6;

  float wave = (w1 + w2) * k;

  // Displace along the radius: this is the height field's gradient, near enough.
  float amp = (0.010 + uLevel * 0.010) * wave;
  vec2 p = uv - dir * amp / vec2(aspect, 1.0);

  vec3 col;
  float sep = amp * 0.4;
  col.r = src(p + dir * sep / aspect).r;
  col.g = src(p).g;
  col.b = src(p - dir * sep / aspect).b;

  // Crest lighting — bright on the leading face, dark in the trough.
  col *= 1.0 + wave * 0.55;
  col += vec3(0.4, 0.7, 1.0) * max(wave, 0.0) * 0.25 * k;

  return vec4(col, 1.0);
}
