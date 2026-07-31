// TILES — each word becomes a solid tile on a grid, lifted by a wave radiating
// from an orbiting source, with fake extruded sides so the grid reads as 3D.
//
// Technique from reference/07-tile-wave.md. That shader raymarches a domain-
// repeated grid of boxes whose heights are driven by an orbiting sphere:
//
//   id      = floor(p.xz / rep)              per-cell identity
//   hash    = rand(id)                       per-cell phase offset
//   bsDist  = length(sourceXZ - cellCentre)  distance to the agitator
//   height  = sin(hash*2PI + t*(2 + bsDist*k)) * amp * (1 - pow(falloff, .9))
//
// Three things make that wave read well, and all three port to 2D:
//   1. Per-cell *hash phase*, so tiles do not move in lockstep.
//   2. Frequency that rises with distance from the source, which is what makes
//      the wave look like it propagates rather than pulses uniformly.
//   3. Amplitude falling off with distance, so there is a clear epicentre.
//
// We cannot raymarch, so the extrusion is faked: sample the cell's content
// shifted up by the height to get the top face, and fill the gap left underneath
// with a darkened smear of the cell's bottom edge as the side face. Cheap, and
// at these heights it is indistinguishable from real extrusion.
//
// Also taken: the reference shades box faces by normal (n.x / n.y / n.z each get
// their own colour), which is what sells the solidity. Here the top face lightens
// with height and the side face is flatly darker — the same idea with two faces
// instead of three.

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec3 base = src(uv).rgb;

  vec2 cell = max(uCell, vec2(1e-4));
  vec2 id = floor(uv / cell);
  vec2 centre = (id + 0.5) * cell;

  // Orbiting agitator, as in the reference's moving sphere.
  float t = iTime;
  vec2 source = uOrigin + vec2(sin(t * 1.8) * 0.18 / aspect, cos(t * 2.2) * 0.18);

  float d = distance(centre * vec2(aspect, 1.0), source * vec2(aspect, 1.0));

  // Amplitude falls off with distance; frequency rises with it. The second part
  // is what makes it propagate instead of pulsing everywhere at once.
  // Reach kept wide: too tight and only a handful of cells move, which reads as
  // "some words shifted" rather than as a surface with a wave crossing it.
  float falloff = 1.0 - pow(smoothstep(0.0, 1.15, d), 0.9);
  float phase = hash21(id) * 6.2831;
  float wave = sin(phase + t * (2.2 + d * 3.4) + mix(0.0, uBar * 6.2831, uLocked));

  float h = wave * cell.y * 0.42 * falloff * k * (0.55 + uBass * 0.9);

  // Position within this cell, and the same in cell units.
  float ly = (uv.y - id.y * cell.y) / cell.y;
  float hl = h / cell.y;
  float srcLy = ly - hl;

  vec3 col;

  if (srcLy >= 0.0 && srcLy <= 1.0) {
    // Top face — the tile's own content, lifted.
    col = src(vec2(uv.x, (id.y + srcLy) * cell.y)).rgb;
    col *= 1.0 + hl * 0.85;                       // catches light as it rises
  } else if (srcLy < 0.0) {
    // Side face — the extruded wall below a raised tile. Smear of its bottom row.
    col = src(vec2(uv.x, id.y * cell.y + cell.y * 0.02)).rgb * 0.30;
    float depth = clamp(-srcLy / max(abs(hl), 1e-4), 0.0, 1.0);
    col *= 1.0 - depth * 0.55;                    // darker the further down
  } else {
    // Tile sank below its slot — the floor of the recess.
    col = src(vec2(uv.x, (id.y + 1.0) * cell.y - cell.y * 0.02)).rgb * 0.18;
  }

  // Grout: thin dark seams so the tiles read as separate objects.
  vec2 g = abs(fract(uv / cell) - 0.5);
  // Wide enough to actually register — at 0.46 the seams were sub-pixel and the
  // grid never read as separate objects.
  float seam = smoothstep(0.38, 0.50, max(g.x, g.y));
  col *= 1.0 - seam * 0.90 * k;

  // Rim light along the top edge of each raised tile.
  float rim = smoothstep(0.0, 0.06, srcLy) * (1.0 - smoothstep(0.06, 0.16, srcLy));
  col += vec3(0.55, 0.72, 1.0) * rim * max(hl, 0.0) * (1.2 + uTreble);

  return vec4(mix(base, col, k), 1.0);
}
