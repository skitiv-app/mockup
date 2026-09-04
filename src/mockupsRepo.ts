import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brand, Mockup, ShapeKey, Box } from "./types";

const BUCKET = "mockups";
const SIGNED_TTL = 60 * 60 * 24 * 7; // 7 days
const URL_CACHE_KEY =
  "mockup-signed-urls:" + (import.meta.env.VITE_SUPABASE_URL || "");
const URL_REFRESH_MARGIN = 60 * 60 * 1000; // refresh when <1h left

type UrlCache = Record<string, { url: string; exp: number }>;

function readUrlCache(): UrlCache {
  try {
    return JSON.parse(localStorage.getItem(URL_CACHE_KEY) || "{}") as UrlCache;
  } catch {
    return {};
  }
}

function writeUrlCache(c: UrlCache) {
  try {
    localStorage.setItem(URL_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota */
  }
}

// Returns a signed URL per path, reusing cached URLs so the browser can serve
// the image from its HTTP cache instead of refetching on every load.
async function signPaths(
  supabase: SupabaseClient,
  paths: string[]
): Promise<Record<string, string>> {
  const cache = readUrlCache();
  const now = Date.now();
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const p of paths) {
    const hit = cache[p];
    if (hit && hit.exp - now > URL_REFRESH_MARGIN) out[p] = hit.url;
    else missing.push(p);
  }

  if (missing.length) {
    const { data } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(missing, SIGNED_TTL);
    for (const item of data ?? []) {
      if (!item.signedUrl || !item.path) continue;
      out[item.path] = item.signedUrl;
      cache[item.path] = {
        url: item.signedUrl,
        exp: now + SIGNED_TTL * 1000,
      };
    }
    writeUrlCache(cache);
  }
  return out;
}

// Row shape in the `mockups` table.
interface Row {
  id: string;
  org_id: string;
  created_by: string | null;
  name: string;
  image_path: string;
  width: number;
  height: number;
  tone: "light" | "dark" | null;
  brand: string | null;
  categories: string[] | null;
  placements: Partial<Record<ShapeKey, Box[]>>;
  locked: boolean;
  two_sided: boolean | null;
}

const THUMB_MAX = 900; // longest edge, px
const THUMB_QUALITY = 0.82;

// Thumbnails live next to the original, so no extra DB column is needed.
function thumbPathFor(imagePath: string): string {
  return imagePath.replace(/\.[^./]+$/, "") + "_thumb.webp";
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

// Downscale to a small WebP. ~95% smaller than the full-res PNG.
async function makeThumbBlob(src: string): Promise<Blob | null> {
  try {
    const img = await loadImg(src);
    const scale = Math.min(1, THUMB_MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", THUMB_QUALITY)
    );
  } catch {
    return null;
  }
}

async function uploadThumb(
  supabase: SupabaseClient,
  imagePath: string,
  src: string
): Promise<void> {
  const blob = await makeThumbBlob(src);
  if (!blob) return;
  await supabase.storage
    .from(BUCKET)
    .upload(thumbPathFor(imagePath), blob, {
      upsert: true,
      contentType: "image/webp",
      cacheControl: "31536000",
    });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:(.*?);/.exec(head)?.[1] || "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Load all mockups for the caller's org (RLS scopes by org_id) and turn each
// stored image into a short-lived signed URL used as the mockup `src`.
export async function loadMockupsFromDb(
  supabase: SupabaseClient
): Promise<Mockup[]> {
  const { data, error } = await supabase
    .from("mockups")
    .select("*")
    .order("updated_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as Row[];
  const urls = await signPaths(supabase, [
    ...rows.map((r) => r.image_path),
    ...rows.map((r) => thumbPathFor(r.image_path)),
  ]);
  const out: Mockup[] = [];
  for (const r of rows) {
    const full = urls[r.image_path] ?? "";
    out.push({
      id: r.id,
      name: r.name,
      src: full,
      thumbSrc: urls[thumbPathFor(r.image_path)] || full,
      width: r.width,
      height: r.height,
      tone: r.tone ?? "light",
      brand: (r.brand as Brand) ?? undefined,
      categories: (r.categories && r.categories.length
        ? r.categories
        : r.brand
        ? [r.brand]
        : []) as string[],
      placements: r.placements ?? {},
      locked: r.locked,
      twoSided: !!r.two_sided,
      imagePath: r.image_path,
    });
  }
  return out;
}

// Existing mockups predate thumbnails (thumbSrc === src). Generate and upload
// their previews in the background, one at a time so the tab stays responsive.
// Silently no-ops if the user lacks write access.
export async function backfillThumbnails(
  supabase: SupabaseClient,
  mockups: Mockup[],
  onDone?: (id: string, thumbSrc: string) => void
): Promise<void> {
  const pending = mockups.filter(
    (m) => m.imagePath && (!m.thumbSrc || m.thumbSrc === m.src)
  );
  for (const m of pending) {
    try {
      await uploadThumb(supabase, m.imagePath!, m.src);
      const path = thumbPathFor(m.imagePath!);
      const signed = await signPaths(supabase, [path]);
      if (signed[path]) onDone?.(m.id, signed[path]);
    } catch {
      /* keep going; card falls back to the full image */
    }
  }
}

// Save a mockup on lock: upload its image once, then upsert the row (frames +
// metadata + locked). Skips re-upload if the image is already in storage.
export async function saveMockupToDb(
  supabase: SupabaseClient,
  mockup: Mockup,
  orgId: string,
  userId: string | null
): Promise<string> {
  let imagePath = mockup.imagePath;
  if (!imagePath) {
    imagePath = `${orgId}/${mockup.id}.png`;
    const blob = dataUrlToBlob(mockup.src);
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(imagePath, blob, {
        upsert: true,
        contentType: "image/png",
        cacheControl: "31536000",
      });
    if (upErr) throw upErr;
  }

  // Preview image for the cards. Non-fatal if it fails.
  await uploadThumb(supabase, imagePath, mockup.src).catch(() => {});

  const { error } = await supabase.from("mockups").upsert({
    id: mockup.id,
    org_id: orgId,
    created_by: userId,
    name: mockup.name,
    image_path: imagePath,
    width: mockup.width,
    height: mockup.height,
    tone: mockup.tone ?? "light",
    brand: mockup.brand ?? null,
    categories: mockup.categories ?? [],
    placements: mockup.placements ?? {},
    locked: mockup.locked ?? true,
    two_sided: mockup.twoSided ?? false,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return imagePath;
}

// Owner-only: flip locked back to false (server trigger blocks members).
export async function setMockupLocked(
  supabase: SupabaseClient,
  id: string,
  locked: boolean
): Promise<void> {
  const { error } = await supabase
    .from("mockups")
    .update({ locked, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// Remove a mockup row and its stored image.
export async function deleteMockupFromDb(
  supabase: SupabaseClient,
  mockup: Mockup
): Promise<void> {
  if (mockup.imagePath) {
    await supabase.storage
      .from(BUCKET)
      .remove([mockup.imagePath, thumbPathFor(mockup.imagePath)]);
  }
  const { error } = await supabase.from("mockups").delete().eq("id", mockup.id);
  if (error) throw error;
}

// Update just a mockup's categories (owner organizing a saved mockup).
export async function updateMockupTwoSided(
  supabase: SupabaseClient,
  id: string,
  twoSided: boolean
): Promise<void> {
  const { error } = await supabase
    .from("mockups")
    .update({ two_sided: twoSided, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function updateMockupCategories(
  supabase: SupabaseClient,
  id: string,
  categories: string[]
): Promise<void> {
  const { error } = await supabase
    .from("mockups")
    .update({ categories, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// The workspace's owner-defined category list (shared with members).
export async function loadCategoryList(
  supabase: SupabaseClient
): Promise<string[] | null> {
  const { data, error } = await supabase.from("org_state").select("settings").limit(1);
  if (error) return null;
  const s = data && data[0] ? (data[0].settings as any) : null;
  return s && Array.isArray(s.categories) ? (s.categories as string[]) : null;
}

export async function saveCategoryList(
  supabase: SupabaseClient,
  orgId: string,
  categories: string[]
): Promise<void> {
  const { error } = await supabase.from("org_state").upsert({
    org_id: orgId,
    settings: { categories },
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
