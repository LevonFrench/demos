// CURSOR — always-on pass that lets the pointer physically shove the wall around.
//
// Three overlapping forces, all local to the cursor:
//   push   the glyphs are displaced radially away, like a finger under fabric
//   drag   fast movement smears the wall along the direction of travel
//   swirl  holding the button winds the text into a vortex
//
// Runs after base and before the fired effects, so an effect fired at the cursor
// inherits an already-deformed wall.
vec4 fx(vec2 uv) {
  if (uCursor < 0.001) return src(uv);

  float aspect = iResolution.x / iResolution.y;
  vec2 d = (uv - uMouse) * vec2(aspect, 1.0);
  float dist = length(d);

  // Radius grows a little with the low end so it breathes with the track.
  float radius = 0.16 + uBass * 0.06 + uMouseDown * 0.10;
  float falloff = smoothstep(radius, 0.0, dist);
  if (falloff < 0.001) return src(uv);

  vec2 dir = d / max(dist, 1e-5);

  // PUSH — displace outward. Negative on press so it sucks inward instead.
  float polarity = mix(1.0, -1.0, uMouseDown);
  float push = falloff * falloff * (0.055 + uLevel * 0.03) * polarity;

  // DRAG — smear along travel, strongest right under the cursor.
  vec2 drag = uMouseVel * falloff * 0.09;

  // SWIRL — tangential winding while held.
  float swirl = falloff * uMouseDown * 2.2;
  vec2 tangent = vec2(-dir.y, dir.x);

  vec2 offset = dir * push + drag + tangent * swirl * 0.045;
  offset /= vec2(aspect, 1.0);

  vec2 p = uv - offset * uCursor;

  // Slight chromatic stretch in the deformed zone so the displacement reads.
  float sep = length(offset) * 0.25 * uCursor;
  vec3 col;
  col.r = src(p + dir * sep / vec2(aspect, 1.0).x).r;
  col.g = src(p).g;
  col.b = src(p - dir * sep / vec2(aspect, 1.0).x).b;

  // Cool highlight where the wall is under tension.
  float tension = falloff * (length(drag) * 6.0 + uMouseDown * 0.35);
  col += vec3(0.45, 0.62, 1.0) * tension * 0.5 * max(col.r, max(col.g, col.b));

  return vec4(col, 1.0);
}
