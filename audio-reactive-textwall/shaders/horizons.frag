// HORIZONS — a landscape. Ground plane, ridgeline, sun on the horizon.
//
// Third base scene. Where DRIFT inverts radius to get a tunnel, this inverts
// HEIGHT to get a floor:
//
//     depth = camHeight / (horizonY - screenY)
//
// For a screen point below the horizon, that is the exact distance to the point
// on an infinite ground plane it looks at. Multiply the horizontal screen
// coordinate by that depth and you have the world position — perspective for a
// whole floor in two divides, no raymarching.
//
// Techniques from the library:
//   * grid lines antialiased by dividing through fwidth (ref 06, the racer) —
//     essential here because the grid compresses to infinity at the horizon and
//     a fixed line width aliases into moire long before it gets there;
//   * ridgeline from fbm, sculpted per column, in the spirit of the dune
//     surfFunc layering (ref 03);
//   * banded sun, which is what makes it read as synthwave rather than sunset;
//   * per-column frequency bands so the ridge is played by the spectrum.

vec4 fx(vec2 uv) {
  float aspect = iResolution.x / iResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // Horizon sits low, and drifts gently so the frame never feels locked.
  float hy = 0.06 + sin(iTime * 0.11) * 0.012;

  // Forward travel. Bass on the throttle.
  float travel = iTime * (2.2 + uBass * 4.5);

  // Lateral sway — the whole world slides, as if cornering.
  float sway = sin(iTime * 0.19) * 0.9 + uMid * 0.25;

  vec3 col;

  // ================= SKY =================================================
  float above = p.y - hy;

  vec3 skyHi = vec3(0.05, 0.02, 0.13);
  vec3 skyLo = vec3(0.42, 0.07, 0.34);
  vec3 sky = mix(skyLo, skyHi, smoothstep(0.0, 0.75, above));

  // Sun: a disc just above the horizon, cut by horizontal bands. The bands are
  // the whole look — a plain disc reads as a sunset, a banded one as synthwave.
  vec2 sunPos = vec2(sway * 0.22, hy + 0.20);
  float sunR = length((p - sunPos) * vec2(1.0, 1.35));
  float sunDisc = smoothstep(0.20, 0.19, sunR);

  // Band gaps widen toward the bottom of the disc.
  float bandY = (p.y - sunPos.y) * 42.0;
  float gap = smoothstep(0.35, 0.5, fract(bandY))
            * smoothstep(0.0, 0.35, p.y - (hy - 0.02));
  float sunMask = sunDisc * (1.0 - gap * smoothstep(0.16, -0.06, p.y - sunPos.y));

  vec3 sunCol = mix(vec3(1.0, 0.85, 0.25), vec3(1.0, 0.15, 0.45),
                    smoothstep(-0.18, 0.20, p.y - sunPos.y));
  sky = mix(sky, sunCol, sunMask);
  sky += sunCol * 0.30 * exp(-sunR * 5.0) * (0.6 + uLevel * 0.8);

  // Stars, thinning toward the horizon.
  vec2 starCell = floor(p * 90.0);
  float star = step(0.995, hash21(starCell)) * smoothstep(0.05, 0.5, above);
  sky += vec3(0.8, 0.85, 1.0) * star;

  // ================= RIDGELINE ===========================================
  // Silhouette height per screen column, from two fbm octaves plus the
  // spectrum, so the skyline is literally played by the music.
  float colX = p.x * 0.9 + sway * 0.35;
  float ridgeN = fbm(vec2(colX * 1.7, 11.3)) * 0.62
               + fbm(vec2(colX * 4.3, 27.1)) * 0.22;

  float bandIdx = clamp(p.x * 0.5 + 0.5, 0.0, 1.0);
  float band = fft(pow(bandIdx, 1.5));

  float ridgeH = ridgeN * 0.16 + band * 0.085;
  float ridgeTop = hy + ridgeH;

  // Fill below the ridge, above the horizon.
  float inRidge = smoothstep(0.004, 0.0, p.y - ridgeTop) * step(hy, p.y);

  vec3 ridgeCol = mix(vec3(0.10, 0.03, 0.16), vec3(0.30, 0.08, 0.42),
                      smoothstep(hy, ridgeTop, p.y));
  // Lit rim along the crest, brighter where its band is loud.
  float rim = smoothstep(0.012, 0.0, abs(p.y - ridgeTop));
  ridgeCol += vec3(1.0, 0.35, 0.6) * rim * (0.5 + band * 2.2);

  sky = mix(sky, ridgeCol, inRidge);

  // ================= GROUND ==============================================
  // depth = camHeight / (horizon - y). This is the projection, inverted.
  float below = hy - p.y;
  float z = 0.32 / max(below, 1e-4);

  float wx = p.x * z + sway * 2.0;
  float wz = z + travel;

  // Grid, antialiased by its own screen-space derivative. Without dividing
  // through fwidth the lines converge into moire well before the horizon.
  vec2 gcell = vec2(wx, wz);
  vec2 gd = abs(fract(gcell) - 0.5) / max(fwidth(gcell), 1e-5);
  float gline = 1.0 - min(min(gd.x, gd.y), 1.0);

  // Terrain relief: dunes rolling across the floor, brightening the grid where
  // the ground rises. Cheap stand-in for real displacement, and at this angle
  // it reads the same.
  float dune = fbm(vec2(wx * 0.22, wz * 0.10)) * 0.5
             + fbm(vec2(wx * 0.9, wz * 0.4)) * 0.2;

  vec3 gridCol = mix(vec3(0.10, 0.55, 0.95), vec3(0.95, 0.20, 0.65),
                     clamp(dune * 1.6, 0.0, 1.0));
  vec3 ground = gridCol * gline * (0.55 + uBass * 1.4);
  ground += vec3(0.03, 0.01, 0.07);
  ground += gridCol * 0.10 * dune;

  // Distance fog — the horizon has to dissolve, or the grid pops at the seam.
  float fog = exp(-below * 22.0);
  ground = mix(ground, skyLo * 0.7, fog);

  // ================= COMPOSITE ===========================================
  col = p.y > hy ? sky : ground;

  // Horizon glow, straddling the seam and hiding it.
  col += vec3(1.0, 0.35, 0.55) * exp(-abs(p.y - hy) * 55.0) * (0.35 + uLevel * 0.7);

  // Vignette.
  col *= 1.0 - smoothstep(0.55, 1.35, length(p)) * 0.55;

  return vec4(col, 1.0);
}
