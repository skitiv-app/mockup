import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import { SupabaseProvider } from "./auth/SupabaseProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <SupabaseProvider>
          <App />
        </SupabaseProvider>
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
);
