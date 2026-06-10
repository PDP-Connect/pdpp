# Design: add-docker-core-deploy-target

## Decision 1: First-boot bootstrap lives in the Node supervisor, not a shell entrypoint

The design note sized this as "a shell script entrypoint." The selected shape
is a small ESM module (`deploy/railway/core-first-boot.mjs`) called by the
existing `core-supervisor.mjs` before it spawns the reference and console.
Rationale: the supervisor is already the image CMD and already owns child env
construction; a Node module is unit-testable offline with `node --test`
(`scripts/docker-core-first-boot.test.mjs`), needs no `openssl`/shell quoting,
and keeps one process tree (no exec-chain). The CMD is unchanged, so the
published Railway template keeps working byte-for-byte.

## Decision 2: Gate by default — a missing password is generated, never ignored

The runtime's historical fallback for a missing `PDPP_OWNER_PASSWORD` is owner
auth disabled. For a standalone container that is an ungated-data foot-gun, so
the supervisor now guarantees a password exists on every boot:

- env var set -> used as-is, no files touched, no banner (Railway/Fly path);
- persisted file on the data volume -> reused, one non-secret log pointer;
- neither -> generate (18 random bytes, base64url), persist mode-0600 to the
  data dir, print the one-time banner.

The banner is the only surface that ever carries the password (plus the 0600
file). If persistence fails (read-only fs, no volume), the boot still gates
with the generated password and the banner says it will rotate — fail-gated,
never fail-open.

The data dir derives from `PDPP_DB_PATH`'s directory, so "keep the database"
and "keep the credentials" are the same named volume.

## Decision 3: Credential encryption key is auto-provisioned only for SQLite boots

SQLite storage means the quickstart: the key file lands beside the database on
the same volume (`PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE`), giving Railway-parity
("the template generates `PDPP_CREDENTIAL_ENCRYPTION_KEY` automatically")
without printing the key anywhere. Postgres boots skip generation: on managed
platforms the rootfs is ephemeral, and a silently rotating key would strand
sealed credentials — the existing explicit fail-closed contract
(`credential-encryption.js`) is more honest there. The production compose
instead requires the key in `.env` via compose's `:?` fail-fast syntax.

## Decision 4: Exactly two user-facing paths

Per the prior-art research (n8n, Plausible, Umami, Outline, Coolify): peers
ship at most one low-friction Docker path. PDPP presents two and only two —
the zero-flag `docker run` quickstart (SQLite, named volume) and a minimal
production compose (Postgres + pgvector) at `deploy/docker/docker-compose.yml`
that is downloadable without a clone. The repo-root compose remains the
development/owner stack and is explicitly signposted as not the self-host
entry point. Fly stays a command block, never a fabricated button.

## Residual Risks

- `PDPP_REFERENCE_ORIGIN=http://localhost:3000` is now baked into the image.
  A manual platform deploy that previously left it unset (and relied on the
  realized-listener fallback) would now advertise localhost until the operator
  sets the variable. The published Railway template and the documented Fly
  command both set it explicitly; the deploy preflights
  (`check-railway-deploy-env.mjs`, `check-flyio-deploy-env.mjs`) already
  reject an unset/non-HTTPS origin.
- The quickstart pins the moving `:main` tag for freshness; the runbook points
  operators at `sha-<rev>` tags for reproducible upgrades. The Railway
  template continues to pin concrete tags.
- The first-boot banner is visible to anyone who can run `docker logs` on the
  host. That is the intended trust boundary (same as n8n/Umami first-run
  credentials): host access already implies volume access.
