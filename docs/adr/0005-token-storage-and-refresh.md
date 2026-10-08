# ADR-0005: Token storage and rotation-safe refresh

Status: Accepted (2026-10-08)
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

### Additions after review (2026-10-08)

- **Windows permissions.** POSIX modes do nothing on NTFS. When the
  config directory is created on Windows, the server applies
  `icacls <dir> /inheritance:r /grant:r *<user-SID>:(OI)(CI)F
*S-1-5-18:(OI)(CI)F`, which restricts access to the current user and
  SYSTEM. Files created inside inherit that ACL. The SID is read with
  `whoami /user`, and no shell is involved. This is best effort: if it
  fails, a warning is logged and `doctor` reports it. The directory
  under `%APPDATA%` is already private to the user profile by default. When the
  folder is created from an elevated process, Windows also keeps an explicit
  Administrators entry; administrators can access any file anyway, so this is accepted.
  `doctor` warns only if broad groups (Users, Everyone, Authenticated Users) have access.
- **Recovering from a lost race.** If a refresh fails with
  `invalid_grant`, the process re-reads the credentials file. If the
  refresh token there differs from the one it just used, another
  process won the race. The process adopts the stored token and does
  not report an error.
- **Interrupted refresh.** If the process dies after Netatmo has issued
  a new pair but before the pair is written, the old refresh token is
  already invalid on Netatmo's side. No client can prevent this. Two
  measures keep the window as small as possible:
  - The new pair is persisted immediately after the response is
    received, before any other work.
  - Because the write is atomic, the file always holds either the old
    complete pair or the new complete pair, never a mix.

  Recovery is `netatmo-energy-mcp login`, and the error message says so.
  If the write itself fails (disk full, file locked), the new pair is
  kept in memory for the current process, the write is retried and the
  failure is logged.

- **Credential replacement.** `login` replaces the client credentials
  and tokens through the same atomic write. On Windows, `rename`
  can fail transiently with `EPERM`/`EBUSY` when another process
  (antivirus, a concurrent reader) has the file open, so the rename is
  retried with backoff for up to about 2 s.
- **Mixed sources.** If `NETATMO_CLIENT_ID` in the environment differs
  from the `client_id` that obtained the stored tokens, refresh would
  fail. Netatmo binds refresh tokens to the app that issued them. The
  server detects the mismatch and asks the user to run `login` again.

## Consequences

- No native dependencies, and the same behaviour on every operating
  system.
- Secrets sit in a plaintext file protected only by OS permissions. This
  is the same model as `gh`, `aws` and `gcloud` credential files, and the
  README states it. Optional keychain storage can be added later behind
  an interface (`TokenStore`).
- The lock file approach is tested with concurrent refresh simulations.
