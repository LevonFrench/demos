// DENSITY — splat every particle into the grid. Produces the field the particle
// solver reads back for pressure, and that paint.frag shades.
//
// Each pixel gathers from the 3x3 neighbourhood: for each neighbouring cell it
// reads that cell's particle, works out where the particle actually IS (cell
// centre + stored sub-cell offset), and weights its contribution by a Gaussian
// of the distance to this pixel.
//
// Gather, not scatter — the same constraint that shapes fluid.frag. A fragment
// shader cannot write to arbitrary pixels, so "splat this particle outward"
// has to be inverted into "collect the particles that would have reached me".
// 3x3 is enough because the stored offset is bounded to about one cell, so no
// particle can influence a pixel more than ~1.5 cells away.

vec4 fx(vec2 uv) {
  vec2 R = 1.0 / uPTexel;
  vec2 here = floor(uv * R) + 0.5;

  vec4 acc = vec4(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nc = here + vec2(float(i), float(j));
      vec4 pa = texture(uPart, nc * uPTexel);

      vec2 x = nc + pa.xy;          // actual particle position, in sim pixels
      vec2 d = here - x;
      float w = exp(-dot(d, d) * 1.6);

      acc.x += w;                   // density
      acc.yz += pa.zw * w;          // momentum
      acc.w += w * length(pa.zw);   // speed, for shading
    }
  }

  return acc;
}
