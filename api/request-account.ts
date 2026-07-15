import { json, supaRest, slug } from "./_lib/util";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const workspaceName = String(body.workspaceName || "").trim();
  const note = String(body.note || "").trim().slice(0, 500);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
  if (workspaceName.length < 2) return json(res, 400, { error: "workspace name required" });

  // Reject duplicate pending requests for the same email.
  const dup = await supaRest("GET", `/account_requests?email=eq.${encodeURIComponent(email)}&status=eq.pending&select=id`);
  if (Array.isArray(dup.data) && dup.data.length) return json(res, 200, { ok: true, duplicate: true });

  const ins = await supaRest("POST", "/account_requests", { email, workspace_name: workspaceName, note }, { Prefer: "return=minimal" });
  if (ins.status >= 300) return json(res, 500, { error: "could not save request" });
  return json(res, 200, { ok: true, slugPreview: slug(workspaceName) });
}
