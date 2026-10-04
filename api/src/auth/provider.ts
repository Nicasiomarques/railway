// Auth port (architecture.md §3: "Auth | Login, sessions, API tokens, RBAC | External provider in the MVP").
// Same spirit as `RuntimeAdapter` (workers/src/runtime/adapter.ts) and `DomainProvider`
// (workers/src/domain/adapter.ts): today there is only one implementation, `LocalAuthProvider`
// (./local.ts), which is just today's behavior (email -> local `users`/`api_tokens` rows) moved
// behind an interface. A real external identity provider (OAuth/OIDC, SSO, ...) can be plugged in
// later as another `AuthProvider`, without `routes/auth.ts` or `app.ts` changing.

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials {
  email: string;
  password: string;
}

export interface LoginResult {
  userId: string;
  // Plain-text token, returned exactly once: only `hashToken(token)` (see ../auth.ts) is ever
  // persisted, so this is the only chance the caller gets to see it.
  token: string;
}

export interface AuthProvider {
  // Creates a brand-new user with a password and issues a token for it. Returns `"email_taken"`
  // instead of throwing when the email is already registered, so the route can map that to a 409
  // without depending on an auth-specific exception type.
  register(credentials: RegisterCredentials): Promise<LoginResult | "email_taken">;

  // Authenticates an existing user by email + password and issues a brand-new API token for it.
  // Returns `null` for invalid credentials (unknown email, no password set, or wrong password —
  // deliberately not distinguished, to avoid confirming whether an email is registered) instead of
  // throwing, so the route can map that to a 401 without depending on an auth-specific exception type.
  login(credentials: LoginCredentials): Promise<LoginResult | null>;
}

// Scope note: we deliberately did not add a `verifyToken`/`logout`/etc. to this interface.
// `authenticate()` in `../auth.ts` already resolves a Bearer token to a user by hashing it and
// looking it up in `api_tokens`, and every route already goes through that hook — there is no
// second caller that needs the same check again through this port. Adding it now would be an
// unused extension point rather than a real one. If a future external provider needs to validate
// tokens *it* issued (as opposed to ones we store locally), that's the moment to extend this
// interface and wire `authenticate()` through it.
