// CONSTELLATION — draws the 64 nodes and their links over the wall, with each
// link carrying its own frequency band.
//
// Technique from reference/16-buffer-points.md: loop the node array per pixel,
// accumulating a node glow and a link as a distance-to-line-segment. The segment
// test is the standard clamped projection, kept here in a form that also returns
// the parameter t, because everything interesting happens ALONG the link.
//
// THE AUDIO IS ON THE LINES. Each node owns a band of the spectrum
// (fft(i/count)), and that band drives its links' thickness, brightness, colour
// and — the part that actually makes it read as a network — the speed of a
// packet travelling down the wire. Bass links at one end pump slow and fat on
// the kick while treble links flicker fast on hats. That is only possible
// because the spectrum arrives as a texture (see [[spectrum-as-texture]]); with
// a single uLevel scalar every line would pulse identically.
//
// Rewritten after the first version read as scattered dashes. Four causes, all
// separate: one link per node (see points.frag), inverse-square node glow whose
// 1/d^2 tail summed to a grey haze over 64 nodes, no gradient or motion along a
// segment, and unbounded additive accumulation that clipped to white on loud
// passages.

// Returns (distance to segment, parameter along it).
vec2 segDT(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return vec2(length(pa - ba * t), t);
}

// Deterministic per-node seed, so each packet starts at its own offset instead
// of every wire in the graph flashing in unison.
float nh(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract((p + p) * p);
}

vec3 hue(float f) {
  return 0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + f * 5.5 + iTime * 0.1);
}

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  vec3 base = src(uv).rgb;
  float aspect = iResolution.x / iResolution.y;
  vec2 p = uv * vec2(aspect, 1.0);

  // Must match points.frag, so a link fades out exactly as it leaves range.
  float range = 0.34 + uLevel * 0.28 + uBeat * 0.06;

  vec3 acc = vec3(0.0);

  for (int i = 0; i < NODE_COUNT; i++) {
    vec2 self = texelFetch(uPts, ivec2(i, 0), 0).xy;
    vec4 links = texelFetch(uPts, ivec2(i, 1), 0);

    float fi = (float(i) + 0.5) / float(NODE_COUNT);
    float band = fft(pow(fi, 1.6));
    vec3 tint = hue(fi);

    // Node: a gaussian core. The old inverse-square had no bound at the centre
    // and a 1/d^2 tail that never really ended, so 64 of them summed into a flat
    // wash with pinpricks in it. A gaussian falls off fast enough that nodes
    // stay distinct however many are on screen.
    // Radius is in aspect-corrected units, where the screen is ~2.2 across —
    // 0.007 was four pixels, which is why the first attempt was invisible.
    float r = 0.016 + band * 0.022;
    float dn2 = dot(p - self, p - self);
    acc += tint * exp(-dn2 / (r * r)) * (0.70 + band * 2.4);
    acc += tint * exp(-dn2 / 0.0060) * (0.06 + band * 0.30); // soft halo

    for (int e = 0; e < 2; e++) {
      vec2 other = e == 0 ? links.xy : links.zw;
      if (other.x < NO_LINK * 0.5) continue; // sentinel: no neighbour in range

      vec2 dt = segDT(p, self, other);
      float strength = 1.0 - smoothstep(range * 0.75, range, distance(self, other));
      if (strength < 0.001) continue;

      float w = 0.0018 + band * 0.0050;
      float line = smoothstep(w, 0.0, dt.x) * strength;

      // Hue walks along the wire, so a link is a gradient rather than a flat
      // stroke and the two ends stay tellable apart.
      vec3 lt = hue(fi + dt.y * 0.10);

      acc += lt * line * (0.55 + band * 2.2);
      acc += lt * smoothstep(w * 6.0, 0.0, dt.x) * strength * (0.05 + band * 0.30); // halo

      // The packet. Its speed is the node's own band, so the network visibly
      // carries the track rather than merely lighting up with it.
      float ph = fract(dt.y - iTime * (0.25 + band * 1.9) + nh(float(i) + float(e) * 7.3));
      float d = min(ph, 1.0 - ph);
      float packet = exp(-d * d * 620.0);
      acc += lt * packet * smoothstep(w * 3.0, 0.0, dt.x) * strength * (0.5 + band * 3.0);
    }
  }

  // Soft clip. Additive accumulation over 64 nodes and up to 128 segments hits
  // white the moment a loud passage widens the links, and everything the effect
  // is doing with colour is lost there.
  acc = acc / (1.0 + acc * 0.5);

  float mask = max(base.r, max(base.g, base.b));
  vec3 col = base * (0.72 + 0.28 * mask) + acc * (0.85 + mask * 0.5);

  return vec4(mix(base, col, k), 1.0);
}
