import { useAuth0 } from "@auth0/auth0-react";
import { ROLES_CLAIM } from "./config";

// Reads the namespaced roles claim off the ID token. The Auth0 Login Action
// sets it (see the setup plan). Members get [] or ["member"]; owners ["owner"].
export function useRoles(): string[] {
  const { user } = useAuth0();
  const raw = (user?.[ROLES_CLAIM] ?? []) as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

export function useIsOwner(): boolean {
  return useRoles().includes("owner");
}
