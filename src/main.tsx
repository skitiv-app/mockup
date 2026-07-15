import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import OrgGate from "./auth/OrgGate";
import { SupabaseProvider } from "./auth/SupabaseProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <OrgGate>
          <SupabaseProvider>
            <App />
          </SupabaseProvider>
        </OrgGate>
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
);
