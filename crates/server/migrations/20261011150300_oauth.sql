-- Accounts step 4: sign in with GitHub, Google and OpenID Connect providers.
CREATE TABLE oauth_identities (
    provider TEXT NOT NULL,                 -- provider id from the configuration ("github", "google", "gitlab"...)
    subject TEXT NOT NULL,                  -- OIDC `sub` / GitHub user id
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email TEXT,                             -- verified email the provider reported, informational
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX oauth_identities_user_provider ON oauth_identities (user_id, provider);

-- Authorization requests in flight (10 minutes). The PKCE verifier and nonce are needed for the exchange.
CREATE TABLE oauth_flows (
    state_hash BYTEA PRIMARY KEY,
    provider TEXT NOT NULL,
    pkce_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    target TEXT NOT NULL,                   -- web | desktop
    client_challenge TEXT NOT NULL,         -- base64url(SHA-256(client verifier))
    link_user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);

-- Single-use callback results (kind login | register | linked) and sign-up tickets (kind ticket), 10 minutes.
CREATE TABLE oauth_results (
    code_hash BYTEA PRIMARY KEY,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    client_challenge TEXT NOT NULL,
    user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    email TEXT,
    suggested_username TEXT,
    display_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL
);
