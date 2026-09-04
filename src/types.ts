export type ShapeKey = "short" | "square" | "long";

export const SHAPE_KEYS: ShapeKey[] = ["short", "square", "long"];

// Shirt brands. Each brand is its own top-level section; light/dark groups sit
// inside it. The first is the default for newly added mockups.
export const BRANDS = ["Comfort Colors", "Gildan"] as const;
export type Brand = (typeof BRANDS)[number];
export const DEFAULT_BRAND: Brand = "Comfort Colors";

// A placement box, stored in the mockup image's own pixel coordinates.
// `rotation` is in degrees, clockwise, around the box center.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export interface Mockup {
  id: string;
  name: string;
  src: string; // data URL
  width: number; // natural pixel size
  height: number;
  // Which colour group this mockup belongs to. Drives the light/dark realism
  // blend and which section it shows under. Defaults to "light".
  tone?: "light" | "dark";
  // Shirt brand — legacy single category (kept for migration).
  brand?: Brand;
  // Owner-defined categories this mockup belongs to. A mockup can be in several
  // sections at once. Empty = the default "Normal" category.
  categories?: string[];
  // Saved placement boxes per shape. A mockup can have several spots (e.g. a
  // photo showing two shirts), each getting its own copy of the design.
  placements: Partial<Record<ShapeKey, Box[]>>;
  // When locked, all placements are frozen and can't be dragged.
  locked?: boolean;
  // Tagged as two-sided: gets a 2nd frame that prints the back design (2.png).
  twoSided?: boolean;
  // Storage path in Supabase ("{org_id}/{id}.png") once the mockup is saved.
  // Present means the image is already uploaded (don't re-upload on lock).
  imagePath?: string;
  // Small WebP preview used for on-screen cards. Exports always use `src`.
  // Falls back to `src` when no thumbnail exists yet.
  thumbSrc?: string;
}

export interface DesignAsset {
  src: string; // data URL
  width: number;
  height: number;
  name: string;
}

// Default aspect ratios per shape (width : height). The user can edit these.
// short  = wide / stacked layout
// square = 1:1
// long   = tall layout
export interface ShapePreset {
  w: number;
  h: number;
}

export const DEFAULT_PRESETS: Record<ShapeKey, ShapePreset> = {
  short: { w: 4500, h: 2794 },
  square: { w: 4096, h: 4096 },
  long: { w: 4494, h: 5097 },
};

// Given a design's width/height, pick the shape whose aspect ratio is closest
// (compared in log space so "twice as wide" and "twice as tall" are symmetric).
export function pickShapeForRatio(
  designW: number,
  designH: number,
  presets: Record<ShapeKey, ShapePreset>
): ShapeKey {
  const target = Math.log(designW / designH);
  let best: ShapeKey = "square";
  let bestDist = Infinity;
  for (const k of SHAPE_KEYS) {
    const dist = Math.abs(Math.log(presets[k].w / presets[k].h) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  return best;
}

// How the design sits inside a placement frame: panned + zoomed, filling the
// frame (cover). x/y are offsets as a fraction of the frame's width/height;
// zoom multiplies the "fill" scale (1 = exactly fill).
export interface DesignFrame {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_DESIGN_FRAME: DesignFrame = { x: 0, y: 0, zoom: 1 };
