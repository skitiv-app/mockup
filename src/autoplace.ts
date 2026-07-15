import type { Box, ShapePreset } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    if (!src.startsWith("data:")) i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

interface Region {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  area: number;
  sumX: number;
  sumY: number;
  sumXX: number;
  sumYY: number;
  sumXY: number;
  pixels: number[];
}

function makeRegion(): Region {
  return {
    minx: Infinity,
    miny: Infinity,
    maxx: -Infinity,
    maxy: -Infinity,
    area: 0,
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumYY: 0,
    sumXY: 0,
    pixels: [],
  };
}

function addPixel(reg: Region, x: number, y: number) {
  reg.area++;
  if (x < reg.minx) reg.minx = x;
  if (x > reg.maxx) reg.maxx = x;
  if (y < reg.miny) reg.miny = y;
  if (y > reg.maxy) reg.maxy = y;
  reg.sumX += x;
  reg.sumY += y;
  reg.sumXX += x * x;
  reg.sumYY += y * y;
  reg.sumXY += x * y;
  reg.pixels.push((y << 16) | x);
}

function shirtRotation(reg: Region): number {
  const bw = reg.maxx - reg.minx + 1;
  const bh = reg.maxy - reg.miny + 1;
  const left = Math.round(reg.minx + bw * 0.18);
  const right = Math.round(reg.maxx - bw * 0.18);
  const minBottomY = reg.miny + bh * 0.48;
  const bottoms = new Map<number, number>();

  for (const p of reg.pixels) {
    const x = p & 0xffff;
    const y = p >> 16;
    if (x < left || x > right || y < minBottomY) continue;
    const cur = bottoms.get(x);
    if (cur === undefined || y > cur) bottoms.set(x, y);
  }

  const pts = [...bottoms.entries()].sort((a, b) => a[0] - b[0]);
  if (pts.length < bw * 0.25) return pcaRotation(reg);

  const ys = pts.map(([, y]) => y).sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * 0.12)];
  const hi = ys[Math.floor(ys.length * 0.88)];
  const kept = pts.filter(([, y]) => y >= lo && y <= hi);
  if (kept.length < bw * 0.2) return pcaRotation(reg);

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of kept) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = kept.length;
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-6) return 0;
  const slope = (n * sxy - sx * sy) / denom;
  let rot = (Math.atan(slope) * 180) / Math.PI;
  if (Math.abs(rot) > 16) rot = pcaRotation(reg);
  if (Math.abs(rot) > 16) rot = Math.sign(rot) * 16;
  return Math.round(rot);
}

function pcaRotation(reg: Region): number {
  if (reg.area < 2) return 0;
  const mx = reg.sumX / reg.area;
  const my = reg.sumY / reg.area;
  const covXX = reg.sumXX / reg.area - mx * mx;
  const covYY = reg.sumYY / reg.area - my * my;
  const covXY = reg.sumXY / reg.area - mx * my;
  const trace = covXX + covYY;
  const spread = Math.hypot(covXX - covYY, 2 * covXY);
  const major = (trace + spread) / 2;
  const minor = (trace - spread) / 2;
  if (minor <= 0 || major / minor < 1.12) return 0;
  const bodyAngle = (0.5 * Math.atan2(2 * covXY, covXX - covYY) * 180) / Math.PI;
  let rot = bodyAngle - 90;
  while (rot < -90) rot += 180;
  while (rot > 90) rot -= 180;
  if (Math.abs(rot) > 18) return 0;
  return Math.round(rot * 0.55);
}

// Turn a detected region (in downscaled coords) into a placement box centered
// on it, sized to a fraction of the region's width, in full mockup pixels.
function boxFromRegion(
  reg: Region,
  W: number,
  H: number,
  mockupW: number,
  mockupH: number,
  preset: ShapePreset,
  widthFactor: number,
  vBias = 0.5
): Box {
  const scaleX = mockupW / W;
  const scaleY = mockupH / H;
  const ratio = preset.w / preset.h;
  const bw = reg.maxx - reg.minx + 1;
  const bh = reg.maxy - reg.miny + 1;
  const cx = (reg.minx + reg.maxx) / 2;
  // vBias positions the box vertically within the shirt (0 = top, 1 = bottom);
  // print usually sits a touch below the middle of the visible panel.
  const cy = reg.miny + bh * vBias;

  let w = bw * widthFactor * scaleX;
  let h = w / ratio;
  const maxW = bw * 0.96 * scaleX;
  const maxH = bh * 0.96 * scaleY;
  if (w > maxW) {
    w = maxW;
    h = w / ratio;
  }
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  let x = cx * scaleX - w / 2;
  let y = cy * scaleY - h / 2;
  x = Math.max(0, Math.min(x, mockupW - w));
  y = Math.max(0, Math.min(y, mockupH - h));
  return { x, y, w, h, rotation: shirtRotation(reg) };
}

// PRIMARY method — grow a region outward from the image center. The center of
// a flat-lay is almost always on the garment, and fabric shades smoothly, so a
// flood that follows gentle colour changes but stops at the crisp garment edge
// captures the shirt even when the background is busy (wood, props, shadows).
function centerRegion(data: Uint8ClampedArray, W: number, H: number): Region | null {
  const at = (x: number, y: number) => (y * W + x) * 4;
  const cx0 = W >> 1;
  const cy0 = H >> 1;

  // Seed colour = average of a small patch at the centre.
  const s = 5;
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (let y = cy0 - s; y <= cy0 + s; y++)
    for (let x = cx0 - s; x <= cx0 + s; x++) {
      const i = at(x, y);
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      n++;
    }
  sr /= n;
  sg /= n;
  sb /= n;

  const LOCAL = 26; // step between neighbours (follows smooth shading)
  const GLOBAL = 72; // max drift from the seed colour (stops runaway growth)
  const visited = new Uint8Array(W * H);
  const stack = [cy0 * W + cx0];
  visited[stack[0]] = 1;
  const reg = makeRegion();

  while (stack.length) {
    const p = stack.pop()!;
    const px = p % W;
    const py = (p / W) | 0;
    const i = at(px, py);
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    addPixel(reg, px, py);

    const tryPush = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      const np = ny * W + nx;
      if (visited[np]) return;
      const j = at(nx, ny);
      const dl = Math.hypot(data[j] - r, data[j + 1] - g, data[j + 2] - b);
      const dg = Math.hypot(data[j] - sr, data[j + 1] - sg, data[j + 2] - sb);
      if (dl < LOCAL && dg < GLOBAL) {
        visited[np] = 1;
        stack.push(np);
      }
    };
    tryPush(px - 1, py);
    tryPush(px + 1, py);
    tryPush(px, py - 1);
    tryPush(px, py + 1);
  }

  const frac = reg.area / (W * H);
  if (frac < 0.04 || frac > 0.85) return null; // implausible → let caller fall back
  return reg;
}

// FALLBACK — background-subtraction + connected components. Good when the
// backdrop is a flat colour and there may be two shirts side by side.
function cornerBlobs(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  maxSpots: number
): Region[] {
  const at = (x: number, y: number) => (y * W + x) * 4;
  const patch = 6;
  const bg: Array<[number, number, number]> = [];
  for (const [cx, cy] of [
    [0, 0],
    [W - patch, 0],
    [0, H - patch],
    [W - patch, H - patch],
  ]) {
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = cy; y < cy + patch; y++)
      for (let x = cx; x < cx + patch; x++) {
        const i = at(x, y);
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    bg.push([r / n, g / n, b / n]);
  }

  const TH = 42;
  const fg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      let minD = Infinity;
      for (const [sr, sg, sb] of bg) {
        const d = Math.hypot(data[i] - sr, data[i + 1] - sg, data[i + 2] - sb);
        if (d < minD) minD = d;
      }
      fg[y * W + x] = minD > TH ? 1 : 0;
    }

  const label = new Int32Array(W * H).fill(-1);
  const blobs: Region[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (fg[s] !== 1 || label[s] !== -1) continue;
    const id = blobs.length;
    const reg = makeRegion();
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % W;
      const py = (p / W) | 0;
      addPixel(reg, px, py);
      if (px > 0 && fg[p - 1] === 1 && label[p - 1] === -1) {
        label[p - 1] = id;
        stack.push(p - 1);
      }
      if (px < W - 1 && fg[p + 1] === 1 && label[p + 1] === -1) {
        label[p + 1] = id;
        stack.push(p + 1);
      }
      if (py > 0 && fg[p - W] === 1 && label[p - W] === -1) {
        label[p - W] = id;
        stack.push(p - W);
      }
      if (py < H - 1 && fg[p + W] === 1 && label[p + W] === -1) {
        label[p + W] = id;
        stack.push(p + W);
      }
    }
    blobs.push(reg);
  }

  const minArea = W * H * 0.03;
  const kept = blobs
    .filter((b) => b.area >= minArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, maxSpots);
  kept.sort((a, b) => a.minx + a.maxx - (b.minx + b.maxx));
  return kept;
}

// Auto-detect the shirt region(s) in a flat-lay photo and return a placement
// box centered on each — an "autocomplete" the user can still nudge.
export async function detectShirtBoxes(
  src: string,
  mockupW: number,
  mockupH: number,
  preset: ShapePreset,
  maxSpots = 2
): Promise<Box[]> {
  const img = await loadImage(src);
  const W = 160;
  const H = Math.max(1, Math.round((img.height / img.width) * W));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;

  const blobs = cornerBlobs(data, W, H, maxSpots);
  // Genuine two-shirt photo: two comparably-sized, both-large blobs. Only then
  // do we place two spots — otherwise a single shirt would sprout a phantom
  // spot on a prop or a patch of background.
  const two = blobs.slice(0, 2);
  const aMin = two.length >= 2 ? Math.min(two[0].area, two[1].area) : 0;
  const aMax = two.length >= 2 ? Math.max(two[0].area, two[1].area) : 1;
  // Both must be big, comparable in size, straddle the vertical middle (as two
  // shirts laid side by side do) and be horizontally separated — this rejects
  // phantom blobs from gradient backdrops or props.
  const straddles = (b: Region) => b.miny < H * 0.55 && b.maxy > H * 0.45;
  const separated =
    two.length >= 2 &&
    Math.min(two[0].maxx, two[1].maxx) < Math.max(two[0].minx, two[1].minx);
  const twoShirts =
    maxSpots >= 2 &&
    two.length >= 2 &&
    aMin >= aMax * 0.6 &&
    aMin >= W * H * 0.08 &&
    straddles(two[0]) &&
    straddles(two[1]) &&
    separated;
  if (twoShirts) {
    return blobs
      .slice(0, maxSpots)
      .map((b) => boxFromRegion(b, W, H, mockupW, mockupH, preset, 0.58, 0.58));
  }

  // Default: grow from the centre — robust on busy single-shirt photos. The box
  // is aligned to the shirt's width (with a small inset) and sits just below
  // the middle of the shirt, where the print goes.
  const center = centerRegion(data, W, H);
  if (center) {
    return [boxFromRegion(center, W, H, mockupW, mockupH, preset, 0.74, 0.58)];
  }

  // Last resort: the single biggest background-subtracted blob, if any.
  if (blobs.length) {
    return [boxFromRegion(blobs[0], W, H, mockupW, mockupH, preset, 0.74, 0.58)];
  }
  return [];
}
