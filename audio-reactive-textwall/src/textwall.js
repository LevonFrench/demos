// Renders the repeated-word wall to a 2D canvas. That canvas becomes the source
// texture every shader pass samples, so the wall itself is plain Canvas2D text —
// crisp, resolution-independent, and trivial to restyle.

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });

export const wall = {
  canvas,
  cell: [0.05, 0.05], // cell size in UV — effects use this to shatter per word
};

export function drawWall({ width, height, text, fontSize, kerning = 0, leading = 1.32, dpr }) {
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));

  const px = fontSize * dpr;
  const word = (text || 'PULSE').toUpperCase();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `700 ${px}px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;
  // Must be set after `font` — assigning font resets letterSpacing to 0. Given
  // in em so the tracking holds its proportion as the font size slider moves.
  ctx.letterSpacing = `${kerning}em`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';

  const gap = px * 0.55;
  // measureText accounts for letterSpacing, so the cell — and therefore uCell,
  // which every per-word effect shatters against — tracks the slider for free.
  const wordW = ctx.measureText(word).width;

  // Snap the cell so a whole number of them spans the canvas. The texture is
  // sampled with REPEAT, and it only wraps *seamlessly* if its period divides
  // its width exactly — otherwise the right edge cuts mid-word and scrolling
  // drags a visible seam across the wall. Costs a sub-pixel nudge to the gap.
  const cols = Math.max(1, Math.round(canvas.width / (wordW + gap)));
  const cellW = canvas.width / cols;

  // Row pitch as a multiple of the font size, so rows keep their proportion as
  // the size slider moves — same reasoning as kerning being given in em. Forced
  // even, because the brick offset alternates on row parity and an odd count
  // would put two same-phase rows next to each other across the vertical wrap.
  const rows = Math.max(2, Math.round(canvas.height / (px * leading) / 2) * 2);
  const cellH = canvas.height / rows;

  for (let r = 0; r <= rows; r++) {
    // Half-cell brick offset on odd rows so the grid doesn't read as columns.
    const xOff = (r % 2) * cellW * 0.5;
    const y = r * cellH + cellH * 0.5;
    // One extra column each side so the brick offset never leaves a gap.
    for (let c = -1; c <= cols; c++) {
      ctx.fillText(word, c * cellW - xOff, y);
    }
  }

  wall.cell = [cellW / canvas.width, cellH / canvas.height];
  return wall;
}
