import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api.js";
import type { CurrentMember } from "../types.js";

interface LoginScreenProps {
  baseUrl: string;
  onLogin: (token: string, member: CurrentMember) => void;
}

export function LoginScreen({ baseUrl, onLogin }: LoginScreenProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.login({ baseUrl, token: null }, email, password);
      onLogin(result.token, result.member);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the Vayo server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__logo">Vayo</div>
        <p className="login-card__subtitle">Sign in to your API docs</p>
        {error && <div className="banner banner--error">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" className="button button--primary" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
