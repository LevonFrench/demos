// FILAMENT — the wall burns away along glowing fractal threads, embers at the
// burn line, and reassembles on release.
//
// Technique from reference/01-kali-tunnel-glow.frag. That shader's look comes
// from a folding iteration (p = abs(p)/clamp(p.x*p.y,..) - 1) tracking a running
// orbit-trap minimum, mapped through exp(-k*ot) so near-misses become thin
// bright filaments. It consumes that field volumetrically, accumulated along a
// raymarch through three planes.
//
// We have no volume, so it is used as a *survival mask* instead: the field says
// which parts of the type burn last. That works because the field is extremely
// high-frequency — which also means it must NOT be used as a displacement
// gradient. Differentiating it yields noise, and the wall dissolves into grey
// mush (tried it; it does). As a threshold it stays crisp.
float kali(vec2 p, float phase) {
  p = abs(5.0 - mod(p * 0.2, 10.0)) - 5.0;
  float ot = 1000.0;
  for (int i = 0; i < 7; i++) {
    p = abs(p) / clamp(p.x * p.y, 0.25, 2.0) - 1.0;
    if (i > 0) ot = min(ot, abs(p.x) + 0.7 * fract(abs(p.y) * 0.05 + phase + float(i) * 0.3));
  }
  return exp(-10.0 * ot);
}

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // Crawl the trap phase on the beat grid when locked, free-running otherwise.
  float phase = mix(iTime * 0.05, floor(iTime * 0.5) * 0.1 + uBar * 0.1, uLocked);

  // Low zoom deliberately — the fold is scale-sensitive and at high zoom the
  // filaments fall below a pixel and alias into static.
  float zoom = 2.1 - uBass * 0.45;
  float f = kali(p * zoom, phase);

  // Rising heat: what is burning lifts slightly. Texture is Y-flipped, so +y
  // is screen-up.
  float lift = (1.0 - f) * k * k * 0.025;
  vec3 base = src(uv + vec2(0.0, lift)).rgb;
  float mask = max(base.r, max(base.g, base.b));

  // Burn front. High field = filament = survives longest, so the type is eaten
  // everywhere except along the threads.
  // f is only large on the threads themselves — exp(-10*ot) is near zero across
  // most of the frame — so the burn has to stay gentle or it consumes the whole
  // wall and leaves a black screen. Floor the survival at 20%: the type dims
  // away from the threads instead of disappearing.
  float burn = clamp(k * 0.75 - f * 1.2, 0.0, 1.0);
  float alive = 1.0 - 0.80 * smoothstep(0.15, 0.60, burn);

  vec3 col = base * alive;

  // Embers riding the burn line.
  float rim = smoothstep(0.18, 0.35, burn) * smoothstep(0.70, 0.45, burn) * mask;
  col += vec3(1.0, 0.42, 0.10) * rim * (1.6 + uBeat * 1.2);

  // The filament glow itself, in the spirit of the reference's lopsided channel
  // powers — that skew is what makes it read as heat rather than as colour.
  vec3 heat = vec3(f * f, f, f * f * f);
  col += heat * k * (0.45 + uTreble * 1.0) * (0.25 + mask * 1.1);

  return vec4(col, 1.0);
}
