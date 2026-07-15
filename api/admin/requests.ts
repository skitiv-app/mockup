import { json, verifyAuth, userEmail, isSuperAdmin, supaRest } from "../_lib/util";

export default async function handler(req: any, res: any) {
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });
  const email = await userEmail(String(claims.sub));
  if (!isSuperAdmin(email)) return json(res, 403, { error: "forbidden" });

  const status = (req.query?.status as string) || "pending";
  const r = await supaRest("GET", `/account_requests?status=eq.${encodeURIComponent(status)}&order=created_at.desc&select=*`);
  return json(res, 200, { requests: r.data || [] });
}
