import { useEffect, useState, type ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { auth0Config } from "./config";

const TRIED = "org_upgrade_tried";

function NoWorkspace() {
  const { user, logout } = useAuth0();
  const [workspace, setWorkspace] = useState("");
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/request-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: user?.email, workspaceName: workspace, note }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Request failed");
      setSent(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Request access</h1>
        {sent ? (
          <p className="auth-muted">
            Thanks — your request is in. An admin will review it and you'll get an
            email with a link to set up your workspace.
          </p>
        ) : (
          <>
            <p className="auth-muted">
              You're signed in as <b>{user?.email}</b> but don't have a workspace
              yet. Request one below.
            </p>
            <input
              className="auth-input"
              placeholder="Workspace name (e.g. My Brand)"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            />
            <textarea
              className="auth-input"
              placeholder="Note to the admin (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
            {err && <p className="auth-err">{err}</p>}
            <button
              className="auth-primary"
              disabled={busy || workspace.trim().length < 2}
              onClick={submit}
            >
              {busy ? "Sending…" : "Request access"}
            </button>
          </>
        )}
        <button
          className="auth-logout auth-block"
          onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
        >
          Log out
        </button>
      </div>
    </div>
  );
}

export default function OrgGate({ children }: { children: ReactNode }) {
  const { user, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const orgId = (user as any)?.org_id as string | undefined;
  const [state, setState] = useState<"checking" | "none" | "ok" | "error">(
    orgId ? "ok" : "checking"
  );

  useEffect(() => {
    if (orgId) {
      sessionStorage.removeItem(TRIED);
      setState("ok");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessTokenSilently({
          authorizationParams: { audience: auth0Config.audience },
        });
        const r = await fetch("/api/my-org", {
          headers: { authorization: `Bearer ${token}` },
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.orgId) {
          // Upgrade this session into the user's organization (adds org_id +
          // roles to the token). Guard against loops with a session flag.
          if (sessionStorage.getItem(TRIED)) {
            setState("error");
          } else {
            sessionStorage.setItem(TRIED, "1");
            await loginWithRedirect({
              authorizationParams: { organization: j.orgId },
            });
          }
        } else {
          setState("none");
        }
      } catch {
        if (!cancelled) setState("none");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (state === "ok") return <>{children}</>;
  if (state === "none") return <NoWorkspace />;
  if (state === "error")
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Something went wrong</h1>
          <p className="auth-muted">
            Couldn't open your workspace. Please log out and back in.
          </p>
        </div>
      </div>
    );
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-spinner" />
        <p className="auth-muted">Opening your workspace…</p>
      </div>
    </div>
  );
}
