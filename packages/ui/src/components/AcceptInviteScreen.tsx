// @vayo/ui — the landing screen for an invite link (?invite=<token>). Shown
// instead of LoginScreen when that query param is present and nobody's
// logged in yet. Creating the account here does NOT log the new member in —
// POST /api/team/accept-invite only ever returns the created member, never a
// session (docs/05-security.md §5: the raw invite token is single-use and
// unrelated to a login session) — so this hands off to the normal sign-in
// form afterward, same as any other new account.

import { useState, type FormEvent } from "react";
import type { TeamRole } from "@vayo/types";
import { api, ApiError } from "../api.js";
import { ROLE_DESCRIPTIONS } from "../role-descriptions.js";

interface AcceptInviteScreenProps {
  baseUrl: string;
  token: string;
  onDone: () => void;
}

export function AcceptInviteScreen({ baseUrl, token, onDone }: AcceptInviteScreenProps): JSX.Element {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [assignedRole, setAssignedRole] = useState<TeamRole | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const member = await api.acceptInvite({ baseUrl, token: null }, token, name, password);
      setAssignedRole(member.role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the Vayo server.");
    } finally {
      setLoading(false);
    }
  }

  if (assignedRole) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-card__logo">Vayo</div>
          <p className="login-card__subtitle">
            Your account is ready as <strong>{assignedRole}</strong> — sign in to continue.
          </p>
          <p className="field__hint">{ROLE_DESCRIPTIONS[assignedRole]}</p>
          <button type="button" className="button button--primary" onClick={onDone}>
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__logo">Vayo</div>
        <p className="login-card__subtitle">You've been invited to join the team — set your name and password.</p>
        {error && <div className="banner banner--error">{error}</div>}
        <label className="field">
          <span>Name</span>
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button type="submit" className="button button--primary" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
