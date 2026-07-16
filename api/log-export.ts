import { json, verifyAuth, readJson, supaRest } from "./_lib/util.js";

// Any workspace member logs one export action (fire-and-forget from the client).
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });
  const orgId = (claims as any)["org_id"] as string | undefined;
  if (!orgId) return json(res, 400, { error: "no org" });
  const body = await readJson(req);
  const count = Math.max(0, parseInt(body.count, 10) || 0);
  const ins = await supaRest(
    "POST",
    "/export_events",
    {
      org_id: orgId,
      user_sub: claims.sub,
      user_email: body.email || null,
      image_count: count,
      format: body.format || null,
      quality: body.quality || null,
    },
    { Prefer: "return=minimal" }
  );
  if (ins.status >= 300) return json(res, 500, { error: "log failed" });
  return json(res, 200, { ok: true });
}
