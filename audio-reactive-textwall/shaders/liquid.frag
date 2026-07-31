// LIQUID — domain-warped fbm. The wall turns into a viscous surface that flows,
// refracts and settles back. Progress scales warp amount so 0 == untouched.
vec4 fx(vec2 uv) {
  float t = iTime * 0.35;
  float k = uProgress;

  vec2 p = uv * vec2(iResolution.x / iResolution.y, 1.0) * 3.0;

  // Two levels of warp — the classic iq domain-warp shape.
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.7),
                fbm(p + 4.0 * q + vec2(8.3, 2.8) - t * 0.6));

  float amp = k * (0.055 + uBass * 0.05 + uLevel * 0.02);
  vec2 warp = (r - 0.5) * amp;

  // Fake refraction: offset each channel along the warp gradient.
  float disp = length(warp) * 0.35;
  vec2 wdir = normalize(warp + 1e-5);

  vec3 col;
  col.r = src(uv + warp + wdir * disp).r;
  col.g = src(uv + warp).g;
  col.b = src(uv + warp - wdir * disp).b;

  // Specular sheen riding the surface.
  float h = fbm(p + 4.0 * q + t);
  float spec = pow(clamp(h, 0.0, 1.0), 6.0) * k * (0.5 + uMid);
  col += vec3(0.35, 0.55, 1.0) * spec * 0.6;

  // Slight desaturated darkening where the fluid is thick.
  col *= 1.0 - k * 0.25 * smoothstep(0.3, 0.9, h);

  return vec4(col, 1.0);
}
