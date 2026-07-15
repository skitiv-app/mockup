import { useEffect, useState } from "react";
import { useApi } from "../api";

interface Req {
  id: string;
  email: string;
  workspace_name: string;
  note: string | null;
  status: string;
  created_at: string;
}

export default function AdminPanel({ onClose }: { onClose: () => void }) {
  const call = useApi();
  const [reqs, setReqs] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const j = await call("/api/admin/requests?status=pending");
      setReqs(j.requests || []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setErr(null);
    try {
      const j = await call("/api/admin/approve", { method: "POST", body: { id, decision } });
      if (decision === "approve" && j.setupUrl) setSetupUrl(j.setupUrl);
      setReqs((r) => r.filter((x) => x.id !== id));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Account requests</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {err && <p className="auth-err">{err}</p>}
        {setupUrl && (
          <div className="setup-url">
            <p><b>Approved.</b> Send this setup link to the new owner:</p>
            <input readOnly value={setupUrl} onFocus={(e) => e.currentTarget.select()} />
            <button onClick={() => navigator.clipboard?.writeText(setupUrl)}>Copy</button>
          </div>
        )}
        {loading ? (
          <p className="auth-muted">Loading…</p>
        ) : reqs.length === 0 ? (
          <p className="auth-muted">No pending requests.</p>
        ) : (
          <div className="req-list">
            {reqs.map((r) => (
              <div className="req-row" key={r.id}>
                <div className="req-info">
                  <b>{r.workspace_name}</b>
                  <span>{r.email}</span>
                  {r.note && <em>{r.note}</em>}
                </div>
                <div className="req-actions">
                  <button className="mini on" disabled={busyId === r.id} onClick={() => decide(r.id, "approve")}>Approve</button>
                  <button className="mini" disabled={busyId === r.id} onClick={() => decide(r.id, "reject")}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
