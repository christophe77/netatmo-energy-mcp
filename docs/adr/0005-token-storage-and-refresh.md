# ADR-0005: Token storage and rotation-safe refresh

Status: Proposed
Date: 2026-10-08

## Context

Netatmo rotates the refresh token on every refresh and **immediately
invalidates the previous one**. Access tokens last about 3 hours. Users
often run several MCP clients at once (Claude Desktop, Cursor, Claude
Code), and each spawns its own server process, all sharing one
credential file. If two processes refresh at the same time, one of them
presents an already-invalidated refresh token and the user is logged
out. A crash during a write could also corrupt the file and lose the
only valid refresh token.

OS keychains need native modules: `keytar` is archived, and the
alternatives add native build risk on three operating systems.

## Decision

- Storage is a JSON file, `credentials.json`, in the per-user config
  directory (see architecture §11). The directory is `0700` and the file
  `0600` on POSIX. On Windows, protection relies on the user-profile ACL,
  which is documented.
- Writes are atomic: write to `credentials.json.<pid>.tmp`, `fsync`,
  then `rename`.
- Refresh is single-flight within a process (one shared promise).
- Across processes, refresh is guarded by `credentials.lock`, created
  with `O_EXCL` and treated as stale after 30 s. After the process takes
  the lock, it **re-reads the file**. If another process already rotated
  the token and it is still valid, it uses that token instead of
  refreshing.
- The token is refreshed proactively 5 minutes before expiry and
  reactively on Netatmo error codes 2 or 3, with one retry.
- `invalid_grant` (or code 30) raises `AuthRequiredError`, whose
  message tells the user to run `netatmo-energy-mcp login`. Tokens are
  never deleted automatically.
- The file stores `client_id`, `client_secret`, `access_token`,
  `refresh_token`, `expires_at`, `scope`, `obtained_at` and a
  `version` field for future migrations.

## Consequences

- No native dependencies, and the same behaviour on every operating
  system.
- Secrets sit in a plaintext file protected only by OS permissions. This
  is the same model as `gh`, `aws` and `gcloud` credential files, and the
  README states it. Optional keychain storage can be added later behind
  an interface (`TokenStore`).
- The lock file approach is tested with concurrent refresh simulations.
