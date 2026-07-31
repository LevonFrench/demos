// GLITCH — horizontal band slicing, block displacement and channel tearing.
// Quantised to the beat grid so the corruption changes on the tempo, not on a
// free-running clock.
vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  // Step the corruption seed on the beat when locked, otherwise ~8x a second.
  float stepId = mix(floor(iTime * 8.0), floor(iTime * 2.0) * 4.0 + floor(uPhase * 4.0), uLocked);
  float seed = hash11(stepId);

  vec2 p = uv;

  // Band slicing — wide horizontal strips shoved sideways.
  float bandId = floor(uv.y * mix(14.0, 42.0, seed));
  float bandRnd = hash21(vec2(bandId, stepId));
  float bandOn = step(bandRnd, 0.30 + k * 0.35);
  float shove = (hash21(vec2(bandId, stepId + 9.0)) - 0.5) * 0.22 * k * (0.5 + uBass);
  p.x += shove * bandOn;

  // Block displacement — coarse tiles jumping in both axes.
  vec2 blockSize = vec2(0.10, 0.045);
  vec2 blockId = floor(uv / blockSize);
  float blockRnd = hash21(blockId + stepId * 1.7);
  if (blockRnd > 1.0 - k * 0.28) {
    p += (hash22(blockId + stepId) - 0.5) * blockSize * 2.4;
  }

  // Channel tearing — each channel reads from its own displaced position.
  float tear = (0.004 + uTreble * 0.012) * k;
  vec3 col;
  col.r = src(p + vec2(tear, 0.0)).r;
  col.g = src(p + vec2(0.0, tear * 0.35 * bandOn)).g;
  col.b = src(p - vec2(tear, 0.0)).b;

  // Scanline dropout — whole rows go dark or blow out.
  float line = hash21(vec2(floor(uv.y * 220.0), stepId));
  col *= 1.0 - step(line, 0.02 * k) * 0.85;
  col += step(0.995 - k * 0.01, line) * 0.35;

  // Quantise the palette as it degrades, like a failing codec.
  float levels = mix(255.0, 5.0, k * 0.75);
  col = floor(col * levels + 0.5) / levels;

  return vec4(col, 1.0);
}
