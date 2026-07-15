import { json, verifyAuth, resolveUserOrg } from "./_lib/util.js";

export default async function handler(req: any, res: any) {
  const claims = await verifyAuth(req);
  if (!claims) return json(res, 401, { error: "unauthorized" });
  const org = await resolveUserOrg(String(claims.sub));
  if (!org) return json(res, 200, { orgId: null });
  return json(res, 200, {
    orgId: org.orgId,
    orgName: org.orgName,
    roles: org.roles,
    isOwner: org.roles.includes("owner"),
  });
}
