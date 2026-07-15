import { useState } from "react";
import { useApi } from "../api";

export default function InviteMember({ onClose }: { onClose: () => void }) {
  const call = useApi();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);

  async function invite() {
    setBusy(true);
    setErr(null);
    try {
      const j = await call("/api/invite-member", { method: "POST", body: { email, role } });
      setSetupUrl(j.setupUrl || "");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Invite to your workspace</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {setupUrl !== null ? (
          <div className="setup-url">
            <p><b>{email}</b> was added as <b>{role}</b>. Send them this setup link:</p>
            <input readOnly value={setupUrl} onFocus={(e) => e.currentTarget.select()} />
            <button onClick={() => navigator.clipboard?.writeText(setupUrl)}>Copy</button>
          </div>
        ) : (
          <>
            <input
              className="auth-input"
              placeholder="teammate@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className="role-pick">
              <label><input type="radio" checked={role === "member"} onChange={() => setRole("member")} /> Member (view/export only)</label>
              <label><input type="radio" checked={role === "owner"} onChange={() => setRole("owner")} /> Owner (full control)</label>
            </div>
            {err && <p className="auth-err">{err}</p>}
            <button className="auth-primary" disabled={busy || !email.includes("@")} onClick={invite}>
              {busy ? "Inviting…" : "Invite"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
