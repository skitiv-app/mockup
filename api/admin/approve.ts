import {
  json, verifyAuth, userEmail, isSuperAdmin, supaRest, mgmt, slug,
  findOrCreateUser, passwordTicket, readJson,
} from "../_lib/util.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });
  const adminEmail = await userEmail(String(claims.sub));
  if (!isSuperAdmin(adminEmail)) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const id = String(body.id || "");
  const decision = String(body.decision || "");
  if (!id || !["approve", "reject"].includes(decision)) return json(res, 400, { error: "id and decision required" });

  const got = await supaRest("GET", `/account_requests?id=eq.${id}&select=*`);
  const reqRow = Array.isArray(got.data) ? got.data[0] : null;
  if (!reqRow) return json(res, 404, { error: "request not found" });
  if (reqRow.status !== "pending") return json(res, 409, { error: "already decided" });

  if (decision === "reject") {
    await supaRest("PATCH", `/account_requests?id=eq.${id}`, { status: "rejected", decided_at: new Date().toISOString() });
    return json(res, 200, { ok: true, status: "rejected" });
  }

  // ---- approve: create org + owner ----
  const email = reqRow.email as string;
  // unique org name
  let base = slug(reqRow.workspace_name);
  let name = base, n = 0, org: any = null;
  while (n < 5) {
    const c = await mgmt("POST", "/organizations", { name, display_name: reqRow.workspace_name });
    if (c.status === 201) { org = c.data; break; }
    if (c.status === 409) { n++; name = `${base}-${n}`; continue; }
    return json(res, 500, { error: "org create failed", detail: c.data });
  }
  if (!org) return json(res, 500, { error: "could not name org" });

  await mgmt("POST", `/organizations/${org.id}/enabled_connections`, {
    connection_id: process.env.AUTH0_DB_CONNECTION_ID, assign_membership_on_login: false,
  });

  const userId = await findOrCreateUser(email);
  await mgmt("POST", `/organizations/${org.id}/members`, { members: [userId] });
  await mgmt("POST", `/organizations/${org.id}/members/${encodeURIComponent(userId)}/roles`, {
    roles: [process.env.AUTH0_OWNER_ROLE_ID],
  });
  const ticket = await passwordTicket(userId);

  await supaRest("PATCH", `/account_requests?id=eq.${id}`, {
    status: "approved", org_id: org.id, decided_at: new Date().toISOString(),
  });

  return json(res, 200, { ok: true, status: "approved", orgId: org.id, orgName: org.display_name, setupUrl: ticket });
}
