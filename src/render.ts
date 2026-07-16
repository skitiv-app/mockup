import type { Box, DesignAsset, Mockup } from "./types";
import { compositeDesignBox, type Garment } from "./composite";

// Compute where the design is drawn inside a placement box, preserving the
// design's aspect ratio ("contain" fit, centered in the box).
export function fitInBox(box: Box, designW: number, designH: number) {
  const scale = Math.min(box.w / designW, box.h / designH);
  const drawW = designW * scale;
  const drawH = designH * scale;
  return {
    x: box.x + (box.w - drawW) / 2,
    y: box.y + (box.h - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Remote images (Supabase signed URLs) need CORS enabled or canvas export
    // taints. Data URLs don't, so only set it for http(s).
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export interface RenderOptions {
  // 0 = crisp sticker on top, 1 = fully printed into the fabric (shadows and
  // wrinkles show through). In between blends the two looks.
  realism?: number;
  garment?: Garment; // light vs dark garment tunes the crease shadow/highlight
  mime?: string; // "image/jpeg" | "image/png"
  quality?: number; // 0..1 for jpeg
  outScale?: number; // 0..1 — downscale the final image (lower quality/size)
}

// Render a single mockup with the design composited into the given box (with
// rotation), at full mockup resolution. Returns an image blob.
export async function renderMockup(
  mockup: Mockup,
  boxes: Box[],
  design: DesignAsset,
  opts: RenderOptions = {}
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = mockup.width;
  canvas.height = mockup.height;
  const ctx = canvas.getContext("2d")!;

  const [bg, art] = await Promise.all([
    loadImage(mockup.src),
    loadImage(design.src),
  ]);

  const mime = opts.mime ?? "image/png";
  // JPEG has no alpha — fill white first so transparent edges don't turn black.
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, mockup.width, mockup.height);
  }
  ctx.drawImage(bg, 0, 0, mockup.width, mockup.height);

  // Composite the design into each box with displacement (warp to the fabric
  // folds) + shading — the technique real mockup generators use.
  const realism = Math.min(1, Math.max(0, opts.realism ?? 0.6));
  const garment = opts.garment ?? "light";
  for (const box of boxes) {
    compositeDesignBox(ctx, bg, mockup.width, mockup.height, art, box, realism, garment);
  }

  // Optionally downscale the finished image for a smaller file (quality knob).
  let out: HTMLCanvasElement = canvas;
  const outScale = opts.outScale ?? 1;
  if (outScale > 0 && outScale < 1) {
    const oc = document.createElement("canvas");
    oc.width = Math.max(1, Math.round(canvas.width * outScale));
    oc.height = Math.max(1, Math.round(canvas.height * outScale));
    const octx = oc.getContext("2d")!;
    if (mime === "image/jpeg") {
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, oc.width, oc.height);
    }
    octx.imageSmoothingQuality = "high";
    octx.drawImage(canvas, 0, 0, oc.width, oc.height);
    out = oc;
  }

  return await new Promise<Blob>((resolve) =>
    out.toBlob((b) => resolve(b!), mime, opts.quality)
  );
}

// Trigger a browser download for a blob.
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function getImageSize(src: string): Promise<{ width: number; height: number }> {
  return loadImage(src).then((img) => ({ width: img.width, height: img.height }));
}

// Downscale an uploaded mockup photo to a sensible max size and re-encode as
// JPEG. Big photos (4000px+) become ~2000px — far less memory/storage and much
// faster with many mockups. 2000px is plenty for Etsy listing images.
export async function loadScaledMockup(
  file: File,
  maxDim = 4000
): Promise<{ src: string; width: number; height: number }> {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  if (Math.max(img.width, img.height) <= maxDim) {
    return { src: dataUrl, width: img.width, height: img.height };
  }
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return { src: canvas.toDataURL("image/png"), width: w, height: h };
}

// Fetch a remote image (e.g. a Supabase signed URL) and return it as a data URL.
// Used so an unlocked (cloud-deleted) mockup still holds its pixels for re-lock.
export function urlToDataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((r) => r.blob())
    .then(
      (b) =>
        new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = reject;
          fr.readAsDataURL(b);
        })
    );
}
