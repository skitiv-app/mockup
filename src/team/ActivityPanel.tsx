import { useEffect, useState } from "react";
import { useApi } from "../api";

interface MemberStat { email: string; exports: number; images: number; last: string; }
interface Recent { user_email: string | null; user_sub: string; image_count: number; format: string | null; created_at: string; }

function when(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ActivityPanel({ onClose }: { onClose: () => void }) {
  const call = useApi();
  const [members, setMembers] = useState<MemberStat[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [totals, setTotals] = useState<{ exports: number; images: number }>({ exports: 0, images: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const j = await call("/api/export-stats");
        setMembers(j.members || []);
        setRecent(j.recent || []);
        setTotals(j.totals || { exports: 0, images: 0 });
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Export activity</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {err && <p className="auth-err">{err}</p>}
        {loading ? (
          <p className="auth-muted">Loading…</p>
        ) : (
          <>
            <p className="auth-muted">
              {totals.exports} export{totals.exports === 1 ? "" : "s"} · {totals.images} images total
            </p>
            <table className="stat-table">
              <thead>
                <tr><th>Member</th><th>Exports</th><th>Images</th><th>Last</th></tr>
              </thead>
              <tbody>
                {members.length === 0 ? (
                  <tr><td colSpan={4} className="auth-muted">No exports yet.</td></tr>
                ) : members.map((m) => (
                  <tr key={m.email}>
                    <td>{m.email}</td>
                    <td>{m.exports}</td>
                    <td>{m.images}</td>
                    <td>{when(m.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recent.length > 0 && (
              <>
                <h3 className="stat-sub">Recent</h3>
                <div className="recent-list">
                  {recent.map((r, i) => (
                    <div className="recent-row" key={i}>
                      <span>{r.user_email || r.user_sub}</span>
                      <span>{r.image_count} × {(r.format || "").toUpperCase()}</span>
                      <span className="auth-muted">{when(r.created_at)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
