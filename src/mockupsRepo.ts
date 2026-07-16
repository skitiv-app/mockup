import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brand, Mockup, ShapeKey, Box } from "./types";

const BUCKET = "mockups";
const SIGNED_TTL = 3600; // 1 hour

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
  const out: Mockup[] = [];
  for (const r of rows) {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(r.image_path, SIGNED_TTL);
    out.push({
      id: r.id,
      name: r.name,
      src: signed?.signedUrl ?? "",
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
      imagePath: r.image_path,
    });
  }
  return out;
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
      .upload(imagePath, blob, { upsert: true, contentType: "image/png" });
    if (upErr) throw upErr;
  }

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
    await supabase.storage.from(BUCKET).remove([mockup.imagePath]);
  }
  const { error } = await supabase.from("mockups").delete().eq("id", mockup.id);
  if (error) throw error;
}

// Update just a mockup's categories (owner organizing a saved mockup).
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
