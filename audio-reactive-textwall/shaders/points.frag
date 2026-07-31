// POINTS — 64 drifting nodes and their nearest-neighbour links, stored in a
// 64x2 texel buffer.
//
// Technique from reference/16-buffer-points.md. The idea worth having is not the
// motion, it is the STORAGE: a tiny region of a buffer used as a structured
// array rather than as an image. The reference puts position in column 0, the
// nearest-neighbour link in column 1, and audio in column 2, branching on
// fragCoord to decide which field it is computing.
//
// Why that matters: without it, the renderer would have to recompute every
// node's nearest neighbour at every screen pixel — 64x64 distance tests per
// pixel, millions of times over. Here it is 64x64 tests total, once, because the
// pass runs at 64x2. The render pass then just reads the answer.
//
// Layout, branching on row:
//   row 0 : xy = position (aspect-corrected space), zw = velocity
//   row 1 : xy = nearest neighbour, zw = second nearest  (-9 = no link)
//
// TWO neighbours, not one. With a single nearest-neighbour link the graph is
// almost all mutual pairs — j is usually nearest to i precisely because i is
// nearest to j — so 64 nodes yielded barely 40 distinct segments, drawn as
// isolated dashes that never joined into anything. A second link is what makes
// chains close into a mesh, and it costs no extra storage: the two positions
// pack into the same vec4 the single link and its strength used to occupy.
// Strength is recovered in the render pass from the distance, which it has to
// measure anyway.
//
// General principle: work belongs at the resolution of the DATA, not at the
// resolution of the screen.

// Deterministic per-node seed.
float h11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract((p + p) * p);
}

vec4 fx(vec2 uv) {
  int i = int(gl_FragCoord.x);
  int row = int(gl_FragCoord.y);

  float aspect = iResolution.x / iResolution.y;
  float fi = float(i);

  // ---- row 0: integrate the node ---------------------------------------
  if (row == 0) {
    vec4 s = texelFetch(uSrc, ivec2(i, 0), 0);

    if (iTime < 0.05 || s == vec4(0.0)) {
      vec2 p = vec2(h11(fi + 0.13), h11(fi + 7.71));
      vec2 v = (vec2(h11(fi + 3.3), h11(fi + 9.1)) - 0.5) * 0.09;
      return vec4(p * vec2(aspect, 1.0), v);
    }

    vec2 pos = s.xy;
    vec2 vel = s.zw;

    // Each node owns a frequency band and is pushed by it, so the constellation
    // moves with the spectrum rather than merely being coloured by it.
    float band = fft(pow((fi + 0.5) / float(NODE_COUNT), 1.6));
    float ang = fi * 2.39996 + iTime * 0.25;
    vel += vec2(cos(ang), sin(ang)) * band * 0.05;

    // Cursor repels, so the network can be pushed around.
    if (uCursor > 0.5) {
      vec2 m = uMouse * vec2(aspect, 1.0);
      vec2 d = pos - m;
      float l = length(d);
      vel += normalize(d + 1e-5) * smoothstep(0.28, 0.0, l) * 0.09;
    }

    // Soft containment rather than a hard bounce. Reflecting at the frame put
    // every node that reached an edge back through the middle on a straight
    // line, so the population spent its time slapping between walls and piling
    // up in the corners. An inward force that only exists near the border keeps
    // them inside while leaving the interior motion untouched.
    // Note the argument order: smoothstep is undefined when edge0 >= edge1, so
    // the inward push at the low edge has to be written as 1 - smoothstep(0, lo)
    // rather than smoothstep(lo, 0).
    //
    // The margin has to be wide enough that the force can actually turn a node
    // around before it arrives. At 0.06 it could not, so nodes reached the wall,
    // the clamp below pinned them there, and — with no reflection to give them
    // an outward-facing velocity — the whole population slowly migrated into a
    // rim around the frame with a hole in the middle.
    vec2 lo = vec2(0.16), hi = vec2(aspect - 0.16, 0.84);
    vel += (1.0 - smoothstep(vec2(0.0), lo, pos)) * 0.55;
    vel -= smoothstep(hi, vec2(aspect, 1.0), pos) * 0.55;

    vel *= 0.975;
    vel = clamp(vel, vec2(-0.5), vec2(0.5));
    pos += vel * min(uDt, 0.05) * 2.4;

    // Backstop only. The soft force above should mean this almost never fires;
    // it exists so that a node which does reach the edge leaves again instead of
    // sticking to it.
    if (pos.x < 0.0)    { pos.x = 0.0;    vel.x =  abs(vel.x); }
    if (pos.x > aspect) { pos.x = aspect; vel.x = -abs(vel.x); }
    if (pos.y < 0.0)    { pos.y = 0.0;    vel.y =  abs(vel.y); }
    if (pos.y > 1.0)    { pos.y = 1.0;    vel.y = -abs(vel.y); }

    return vec4(pos, vel);
  }

  // ---- row 1: nearest neighbour -----------------------------------------
  // 64x64 tests, but only 64 invocations — this is the whole point of keeping
  // the array small and separate from the screen.
  vec2 self = texelFetch(uSrc, ivec2(i, 0), 0).xy;

  // Link range opens up with the level, so the network knits together as the
  // track gets louder and falls apart in the quiet.
  //
  // Sized against the ACTUAL node spacing: 64 nodes over ~1.6x1 units puts the
  // typical nearest neighbour around sqrt(1.6/64) ~= 0.16. A range of 0.16 with
  // a falloff completing at the limit meant every real link resolved to ~zero
  // strength and nothing drew. Range has to comfortably exceed mean spacing.
  float range = 0.34 + uLevel * 0.28 + uBeat * 0.06;

  // Keep the two closest inside range. Positions, not indices — the render pass
  // needs the endpoint anyway, and storing indices would cost it an extra
  // dependent fetch per link for nothing.
  float bestA = 1e5, bestB = 1e5;
  vec2 posA = vec2(NO_LINK), posB = vec2(NO_LINK);
  for (int j = 0; j < NODE_COUNT; j++) {
    if (j == i) continue;
    vec2 o = texelFetch(uSrc, ivec2(j, 0), 0).xy;
    float d = distance(self, o);
    if (d >= range) continue;
    if (d < bestA)      { bestB = bestA; posB = posA; bestA = d; posA = o; }
    else if (d < bestB) { bestB = d;     posB = o; }
  }

  return vec4(posA, posB);
}
