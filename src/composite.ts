import type { Box } from "./types";
import { fitInBox } from "./render";

// Small decoded-image cache so the preview doesn't re-decode on every redraw.
const imgCache = new Map<string, HTMLImageElement>();
export function loadImageCached(src: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(src);
  if (hit && hit.complete) return Promise.resolve(hit);
  return new Promise((res, rej) => {
    const img = new Image();
    // Remote images (Supabase signed URLs) must be CORS-enabled or the preview
    // canvas taints and getImageData throws — which silently hid the design.
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      imgCache.set(src, img);
      res(img);
    };
    img.onerror = rej;
    img.src = src;
  });
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Composite one design box onto `target` the way a Photoshop smart-object +
// displacement map does it:
//   • displacement — the artwork is *warped* so it flows along the garment's
//     folds (value-based shift from a smoothed grayscale of the fabric);
//   • shading — the fabric's broad highlights/shadows are laid over the print.
// The map is generated automatically from the mockup here — no upload needed.
// `mockup` must be at the same resolution as the target (Tw×Th).
export type Garment = "light" | "dark";

export function compositeDesignBox(
  target: CanvasRenderingContext2D,
  mockup: CanvasImageSource,
  Tw: number,
  Th: number,
  art: HTMLImageElement,
  box: Box,
  realism: number,
  garment: Garment = "light"
) {
  const fit = fitInBox(box, art.width, art.height);
  const bw = Math.max(2, Math.round(box.w));
  const bh = Math.max(2, Math.round(box.h));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = ((box.rotation ?? 0) * Math.PI) / 180;

  // Sharp artwork buffer.
  const design = document.createElement("canvas");
  design.width = bw;
  design.height = bh;
  const dctx = design.getContext("2d", { willReadFrequently: true })!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(art, fit.x - box.x, fit.y - box.y, fit.w, fit.h);
  const D = dctx.getImageData(0, 0, bw, bh).data;

  // Two grayscale copies of the fabric under the box (sampled in the box's own
  // frame so folds line up): a FINE one (grain removed, wrinkles kept) and a
  // BROAD one (local lighting). Their difference is the wrinkle *relief* — the
  // same high-pass a PSD "shadows overlay" holds, so broad lighting never dulls
  // the art; only creases and raised threads touch it.
  const min = Math.min(bw, bh);
  const sampleGray = (blur: number) => {
    const c = document.createElement("canvas");
    c.width = bw;
    c.height = bh;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.save();
    g.translate(bw / 2, bh / 2);
    g.rotate(-rad);
    g.translate(-cx, -cy);
    g.filter = `grayscale(1) blur(${Math.max(1, Math.round(blur))}px)`;
    g.drawImage(mockup, 0, 0, Tw, Th);
    g.restore();
    return g.getImageData(0, 0, bw, bh).data;
  };
  const Lf = sampleGray(min * 0.012);
  const Lb = sampleGray(min * 0.05);

  const out = dctx.createImageData(bw, bh);
  const O = out.data;
  // Light garments: creases cast real shadows on the print (shadow-led).
  // Dark garments: printed ink stays opaque and bright, so creases barely
  // darken it while raised threads catch light (highlight-led) — otherwise a
  // light design on a dark shirt goes muddy.
  const kShadow = realism * (garment === "dark" ? 1.0 : 2.2);
  const kHi = realism * (garment === "dark" ? 1.9 : 1.0);

  // No pixel warping — the artwork is read 1:1 so it stays exactly as crisp as
  // the source. Only per-pixel brightness changes (shadow/highlight from the
  // fabric relief), which can't soften edges. This matches the PSD's clean look.
  for (let i = 0; i < D.length; i += 4) {
    const a = D[i + 3];
    if (a === 0) {
      O[i] = O[i + 1] = O[i + 2] = O[i + 3] = 0;
      continue;
    }
    const detail = (Lf[i] - Lb[i]) / 255; // signed relief: −crease / +ridge
    const shadow = detail < 0 ? -detail : 0;
    const ridge = detail > 0 ? detail : 0;
    let darken = shadow * kShadow;
    if (darken > 0.85) darken = 0.85;
    let lighten = ridge * kHi;
    if (lighten > 0.5) lighten = 0.5;

    for (let c = 0; c < 3; c++) {
      let v = D[i + c] / 255 - darken; // Linear Burn (crease shadow)
      if (v < 0) v = 0;
      v = v + (1 - v) * lighten; // Screen (thread highlight)
      O[i + c] = clamp8(v * 255);
    }
    O[i + 3] = a;
  }
  dctx.putImageData(out, 0, 0);

  target.save();
  target.translate(cx, cy);
  target.rotate(rad);
  target.imageSmoothingEnabled = true;
  target.imageSmoothingQuality = "high";
  target.drawImage(design, -box.w / 2, -box.h / 2, box.w, box.h);
  target.restore();
}
