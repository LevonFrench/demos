// DRIFT — a geometric tunnel. No text.
//
// Alternative base scene. The text wall is the project's other scene; this one
// is its own thing, and deliberately samples uText nowhere. Everything
// downstream (cursor, all 19 effects, post, trails) reads uSrc and is
// indifferent to what drew it, so the whole effect library composes over this.
//
// THE MAPPING. The classic tunnel inversion: for a screen point at radius r from
// the vanishing point, depth goes as 1/r. So (angle, 1/r) are the tunnel's
// surface coordinates — angle wraps around the wall, 1/r runs away down it.
// Two coordinates, no raymarching, and correct perspective falls out because the
// inversion IS the projection.
//
// Structure is then just a grid in those coordinates: rings at intervals of
// depth, segments at intervals of angle. Each cell is addressable, so each can
// own a frequency band.

#define TAU 6.28318530718

vec4 fx(vec2 uv) {
  float aspect = iResolution.x / iResolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  // The tunnel leans, so the vanishing point is never parked in the middle of
  // frame — this project ruled that out early and it also just looks better.
  vec2 vp = vec2(sin(iTime * 0.31), cos(iTime * 0.237)) * 0.115;
  p -= vp;

  float r = length(p);
  float a = atan(p.y, p.x);

  // Forward travel. Bass on the throttle, beat gives a short lurch.
  float speed = 0.55 + uBass * 0.85;
  float depth = 1.0 / (r + 0.115) + iTime * speed + uBeat * 0.10;

  // ---- ring / segment grid ---------------------------------------------
  const float SEGMENTS = 18.0;

  // Twist grows with depth, so the tunnel corkscrews away from the camera.
  float twist = depth * 0.09 + sin(depth * 0.22) * 0.8;
  float segCoord = (a / TAU + 0.5) * SEGMENTS + twist;

  float ringCoord = depth * 1.45;

  float ringId = floor(ringCoord);
  float segId = floor(segCoord);
  float ringFr = fract(ringCoord);
  float segFr = fract(segCoord);

  // ---- per-cell audio ---------------------------------------------------
  // Each panel owns a band. Ring index dominates so bands stratify by depth,
  // with the segment index breaking ties around the circumference.
  float cellSeed = fract(abs(ringId) * 0.0731 + abs(segId) * 0.0119);
  float band = fft(pow(cellSeed, 1.4));

  // Panels light on a hashed schedule so the tunnel is not uniformly lit.
  float lit = hash21(vec2(ringId, segId));
  float panelOn = smoothstep(0.62, 0.98, lit + band * 0.55);

  // ---- structure --------------------------------------------------------
  // Grid lines: distance to the nearest cell edge, in both axes.
  float ringLine = 1.0 - smoothstep(0.0, 0.055, min(ringFr, 1.0 - ringFr));
  float segLine = 1.0 - smoothstep(0.0, 0.050, min(segFr, 1.0 - segFr));
  float grid = max(ringLine, segLine);

  // Panel fill, inset from the lines.
  float panel = smoothstep(0.10, 0.28, min(ringFr, 1.0 - ringFr))
              * smoothstep(0.09, 0.26, min(segFr, 1.0 - segFr));

  // ---- colour -----------------------------------------------------------
  // Hue walks with depth so successive rings stay separable.
  vec3 hue = 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + ringId * 0.42 + iTime * 0.12);
  vec3 lineCol = mix(vec3(0.35, 0.55, 1.0), hue, 0.55);

  vec3 col = vec3(0.0);
  col += lineCol * grid * (0.30 + band * 1.9);
  col += hue * panel * panelOn * (0.18 + band * 1.5);

  // Ribs: every 4th ring is heavier, giving the tunnel a structural rhythm
  // rather than an undifferentiated stack of hoops.
  float rib = step(3.5, mod(abs(ringId), 4.0));
  col += lineCol * ringLine * rib * (0.35 + uMid * 0.8);

  // ---- depth cue --------------------------------------------------------
  // r is small far away, so fog keyed on r sinks the far end into darkness.
  float far = smoothstep(0.62, 0.02, r);
  col *= mix(1.0, 0.06, far);

  // Vanishing point glow, sitting at the far end of the bore.
  col += vec3(0.45, 0.30, 0.95) * pow(far, 3.0) * (0.55 + uMid * 0.9);

  // Wall falloff at the near edge of frame, so the bore reads as enclosing.
  col *= 1.0 - smoothstep(0.55, 1.25, r) * 0.55;

  // Faint radial streaks for speed.
  float streak = pow(abs(sin(a * SEGMENTS * 0.5 + twist)), 24.0);
  col += lineCol * streak * far * uBass * 0.35;

  return vec4(col, 1.0);
}
