/**
 * Make the flat background of a product photo transparent, in place, on raw RGBA pixel data.
 *
 * The background colour is read from the image corners. A flood fill from the border walks only through pixels
 * that are very close to that colour (TOLERANCE), so it stops at the soft grey edge of a white bottle instead of
 * walking through it into a white label. Pixels a little further from the background colour (up to TOLERANCE +
 * FEATHER) get a partial alpha so the cut edge is smooth, but the fill does not continue through them.
 *
 * The fill can still slip through a one- or two-pixel gap in a light edge. To close those leaks the background
 * mask is opened: eroded by GAP pixels, re-flooded from the border so only what is still connected to the
 * outside survives, then grown back by GAP pixels inside the original mask. A white label reached only through
 * a narrow gap is cut off and stays opaque.
 */
export function stripBackground(data, w, h, channels = 4, { TOLERANCE = 12, FEATHER = 18, GAP = 3 } = {}) {
  const corners = [0, (w - 1) * channels, (h - 1) * w * channels, ((h - 1) * w + w - 1) * channels];
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((s, i) => s + data[i + c], 0) / corners.length));
  const dist = (p) => {
    const i = p * channels;
    return Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  };
  const n = w * h;
  // 1. Background candidates: everything within TOLERANCE of the corner colour, connected to the border.
  const mask = floodFromBorder(w, h, (p) => dist(p) <= TOLERANCE);
  // 2. Open the mask so leaks through gaps narrower than about 2 * GAP pixels are cut off.
  const eroded = erode(mask, w, h, GAP);
  const core = floodFromBorder(w, h, (p) => eroded[p] === 1, true);
  const opened = dilate(core, w, h, GAP, mask);
  // 3. Alpha: fully transparent inside the opened mask, feathered just outside it where the colour is still close.
  const feathered = dilate(opened, w, h, 1, null);
  for (let p = 0; p < n; p++) {
    const a = p * channels + 3;
    if (opened[p]) data[a] = 0;
    else if (feathered[p]) {
      const d = dist(p);
      data[a] = d >= TOLERANCE + FEATHER ? 255 : Math.round((255 * Math.max(0, d - TOLERANCE)) / FEATHER);
    }
  }
  return bg;
}

/** Flood fill from the four borders through pixels where `inside(p)` holds. Returns a Uint8Array mask. */
function floodFromBorder(w, h, inside, strict = false) {
  const mask = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => {
    if (seen[p]) return;
    seen[p] = 1;
    if (inside(p)) { mask[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < (h - 1) * w) push(p + w);
  }
  void strict;
  return mask;
}

function erode(mask, w, h, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!cur[p]) continue;
      // Pixels on the image border count as background beyond the edge, so the mask is not eroded from outside.
      const l = x > 0 ? cur[p - 1] : 1, rr = x < w - 1 ? cur[p + 1] : 1, u = y > 0 ? cur[p - w] : 1, d = y < h - 1 ? cur[p + w] : 1;
      if (l && rr && u && d) next[p] = 1;
    }
    cur = next;
  }
  return cur;
}

function dilate(mask, w, h, r, within) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!cur[p]) continue;
      const grow = (q) => { if (!within || within[q]) next[q] = 1; };
      if (x > 0) grow(p - 1);
      if (x < w - 1) grow(p + 1);
      if (y > 0) grow(p - w);
      if (y < h - 1) grow(p + w);
    }
    cur = next;
  }
  return cur;
}
