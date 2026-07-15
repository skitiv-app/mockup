import {
  json, verifyAuth, resolveUserOrg, mgmt, findOrCreateUser, passwordTicket,
} from "./_lib/util";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });

  const caller = await resolveUserOrg(String(claims.sub));
  if (!caller) return json(res, 403, { error: "no workspace" });
  if (!caller.roles.includes("owner")) return json(res, 403, { error: "owners only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const asOwner = body.role === "owner";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });

  const userId = await findOrCreateUser(email);
  await mgmt("POST", `/organizations/${caller.orgId}/members`, { members: [userId] });
  const roleId = asOwner ? process.env.AUTH0_OWNER_ROLE_ID : process.env.AUTH0_MEMBER_ROLE_ID;
  await mgmt("POST", `/organizations/${caller.orgId}/members/${encodeURIComponent(userId)}/roles`, { roles: [roleId] });
  const ticket = await passwordTicket(userId);

  return json(res, 200, { ok: true, email, role: asOwner ? "owner" : "member", setupUrl: ticket });
}
