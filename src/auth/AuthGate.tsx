import type { ReactNode } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { auth0Configured } from "./config";
import { useIsOwner } from "./useRole";

function Centered({ children }: { children: ReactNode }) {
  return <div className="auth-screen">{children}</div>;
}

// User chip + logout, fixed to the top-right corner over the app.
function UserBar() {
  const { user, logout } = useAuth0();
  const isOwner = useIsOwner();
  return (
    <div className="auth-bar">
      <span className="auth-role" data-role={isOwner ? "owner" : "member"}>
        {isOwner ? "Owner" : "Member"}
      </span>
      <span className="auth-email">{user?.email ?? user?.name}</span>
      <button
        className="auth-logout"
        onClick={() =>
          logout({ logoutParams: { returnTo: window.location.origin } })
        }
      >
        Log out
      </button>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error, loginWithRedirect } = useAuth0();

  if (!auth0Configured) {
    return (
      <Centered>
        <div className="auth-card">
          <h1>Mockup Studio</h1>
          <p className="auth-muted">
            Auth0 is not configured. Set <code>VITE_AUTH0_DOMAIN</code>,{" "}
            <code>VITE_AUTH0_CLIENT_ID</code> and{" "}
            <code>VITE_AUTH0_AUDIENCE</code> in your environment.
          </p>
        </div>
      </Centered>
    );
  }

  if (isLoading) {
    return (
      <Centered>
        <div className="auth-card">
          <div className="auth-spinner" />
          <p className="auth-muted">Signing you in…</p>
        </div>
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <div className="auth-card">
          <h1>Sign-in problem</h1>
          <p className="auth-muted">{error.message}</p>
          <button className="auth-primary" onClick={() => loginWithRedirect()}>
            Try again
          </button>
        </div>
      </Centered>
    );
  }

  if (!isAuthenticated) {
    return (
      <Centered>
        <div className="auth-card">
          <h1>Mockup Studio</h1>
          <p className="auth-muted">Sign in to open your mockup library.</p>
          <button className="auth-primary" onClick={() => loginWithRedirect()}>
            Log in
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <>
      <UserBar />
      {children}
    </>
  );
}
