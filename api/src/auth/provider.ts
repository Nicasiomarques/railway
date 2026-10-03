// Auth port (architecture.md §3: "Auth | Login, sessions, API tokens, RBAC | External provider in the MVP").
// Same spirit as `RuntimeAdapter` (workers/src/runtime/adapter.ts) and `DomainProvider`
// (workers/src/domain/adapter.ts): today there is only one implementation, `LocalAuthProvider`
// (./local.ts), which is just today's behavior (email -> local `users`/`api_tokens` rows) moved
// behind an interface. A real external identity provider (OAuth/OIDC, SSO, ...) can be plugged in
// later as another `AuthProvider`, without `routes/auth.ts` or `app.ts` changing.

export interface LoginCredentials {
  email: string;
}

export interface LoginResult {
  userId: string;
  // Plain-text token, returned exactly once: only `hashToken(token)` (see ../auth.ts) is ever
  // persisted, so this is the only chance the caller gets to see it.
  token: string;
}

export interface AuthProvider {
  // Authenticates (or, for the local provider, creates) a user and issues a brand-new API token
  // for it. Returns `null` for invalid credentials instead of throwing, so the route can map that
  // to a 401 without depending on an auth-specific exception type.
  login(credentials: LoginCredentials): Promise<LoginResult | null>;
}

// Scope note: we deliberately did not add a `verifyToken`/`logout`/etc. to this interface.
// `authenticate()` in `../auth.ts` already resolves a Bearer token to a user by hashing it and
// looking it up in `api_tokens`, and every route already goes through that hook — there is no
// second caller that needs the same check again through this port. Adding it now would be an
// unused extension point rather than a real one. If a future external provider needs to validate
// tokens *it* issued (as opposed to ones we store locally), that's the moment to extend this
// interface and wire `authenticate()` through it.
