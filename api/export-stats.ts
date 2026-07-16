import { json, verifyAuth, supaRest } from "./_lib/util.js";

const ROLES_CLAIM = "https://mockupstudio/roles";

// Owner-only: per-member export activity for the caller's workspace.
export default async function handler(req: any, res: any) {
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });
  const orgId = (claims as any)["org_id"] as string | undefined;
  const roles = (claims as any)[ROLES_CLAIM];
  const isOwner = Array.isArray(roles) && roles.includes("owner");
  if (!orgId || !isOwner) return json(res, 403, { error: "owners only" });

  const r = await supaRest(
    "GET",
    `/export_events?org_id=eq.${encodeURIComponent(orgId)}&order=created_at.desc&limit=1000&select=*`
  );
  const rows: any[] = Array.isArray(r.data) ? r.data : [];

  const byUser: Record<string, any> = {};
  let totalImages = 0;
  for (const e of rows) {
    const k = e.user_email || e.user_sub;
    if (!byUser[k]) byUser[k] = { email: e.user_email || e.user_sub, exports: 0, images: 0, last: e.created_at };
    byUser[k].exports += 1;
    byUser[k].images += e.image_count || 0;
    if (e.created_at > byUser[k].last) byUser[k].last = e.created_at;
    totalImages += e.image_count || 0;
  }

  return json(res, 200, {
    members: Object.values(byUser).sort((a: any, b: any) => b.images - a.images),
    recent: rows.slice(0, 50),
    totals: { exports: rows.length, images: totalImages },
  });
}
