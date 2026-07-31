// PAINT — shades the particle field as a wet, lit fluid surface over the wall.
//
// This is the one part of the reference that was pasted complete, so it is the
// one part reproduced closely in behaviour:
//
//   * surface normal from the GRADIENT OF THE DENSITY FIELD, not from geometry;
//   * specular from reflecting the view vector off that normal;
//   * two colours mixed by a per-particle scalar, so the fluid looks like two
//     paints being stirred rather than one tinted mass;
//   * alpha from a smoothstep on density, so thin film fades out at the edges;
//   * tanh as a tone curve, which rolls highlights off instead of clipping them.
//
// Density gradient as a normal is the idea worth carrying: any scalar field you
// can sample becomes a lightable surface for the cost of four taps. Same move as
// dune.frag, applied to simulation output rather than to procedural noise.

vec4 fx(vec2 uv) {
  float k = uProgress;
  if (k < 0.001) return src(uv);

  vec3 base = src(uv).rgb;

  vec2 e = uPTexel;
  float dR = texture(uDens, uv + vec2(e.x, 0.0)).x;
  float dL = texture(uDens, uv - vec2(e.x, 0.0)).x;
  float dU = texture(uDens, uv + vec2(0.0, e.y)).x;
  float dD = texture(uDens, uv - vec2(0.0, e.y)).x;

  vec4 dens = texture(uDens, uv);

  // Normal from the density gradient. The pow() on gradient length compresses
  // the range so gentle slopes still catch light — a raw gradient is nearly flat
  // except at blob edges.
  //
  // But the exponent is a noise amplifier: at 0.25 it lifted the quantisation of
  // the quarter-res density grid into hard horizontal banding across the whole
  // frame. 0.5 keeps the soft-slope lighting without printing the grid.
  vec2 g = vec2(dR - dL, dU - dD) * 0.5;
  vec2 N = pow(length(g), 0.5) * normalize(g + 1e-5);
  vec3 n = normalize(vec3(N, 1.0));

  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 r = reflect(-viewDir, n);

  // Cheap procedural environment instead of a cubemap: a bright band overhead
  // plus a warm bounce below, which is enough for wet-looking specular.
  vec3 env = mix(vec3(0.06, 0.08, 0.14), vec3(1.0, 0.96, 0.9),
                 smoothstep(0.0, 0.8, r.y));
  env += vec3(0.9, 0.4, 0.2) * smoothstep(0.4, -0.6, r.y) * 0.35;

  float rho = dens.x;
  float speed = dens.w / max(rho, 1e-4);

  // Two paints, mixed by direction of travel so opposing currents stay visually
  // separate instead of averaging to a single wash.
  vec2 vel = dens.yz / max(rho, 1e-4);
  float c = tanh(3.0 * (vel.x * 1.5)) * 0.5 + 0.5;
  vec3 colA = vec3(1.0, 0.42, 0.05);
  vec3 colB = vec3(0.10, 0.42, 1.0);
  vec3 paint = mix(colA, colB, c);

  // Thickness terms: `a` fades the film in, `b` darkens where it piles deep.
  float a = pow(smoothstep(0.0, 1.6, rho), 0.4);
  float b = exp(-1.4 * smoothstep(0.8, 5.0, rho));

  float spec = pow(max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0), 24.0);

  vec3 col = paint * (1.3 * b + speed * 0.5) * a;
  col += env * spec * 1.6 * a;
  col += env * 0.25 * a * smoothstep(0.0, 2.0, rho);

  // Wall shows through the thin film and tints the thick part.
  float mask = max(base.r, max(base.g, base.b));
  col += base * (1.0 - a * 0.75);
  col *= 0.75 + mask * 0.5;

  col = tanh(col * col);   // roll off highlights rather than clipping

  return vec4(mix(base, col, k), 1.0);
}
