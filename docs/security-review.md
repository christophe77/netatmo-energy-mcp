# Security review: 2026-10-08 (pre-v0.1)

An independent, adversarial review was run on the whole codebase before
the first release. It covered:

- OAuth and the loopback callback
- Where secrets can flow
- Token storage on POSIX and Windows
- The read-only guarantee
- The MCP surface
- Child processes
- The probe sanitizer
- Dependencies
- CI

**Result:** there were no critical or high findings. Every medium and
low finding below has been fixed and has a regression test in
`tests/unit/security-fixes.test.ts`.

## Findings and resolutions

| ID  | Severity   | Finding                                                                                                                                                                | Resolution                                                                                                                                                                                                                                                                                              |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Medium     | A tool call cancelled during a token refresh could abort the refresh after Netatmo had rotated the refresh token, losing it. The user would then have to log in again. | The refresh no longer uses the caller's abort signal. Callers stop _waiting_ (`abortable()`), but the refresh always completes and is saved. (`src/auth/token-manager.ts`)                                                                                                                              |
| M2  | Medium–Low | `rundll32` was started by bare name. On Windows the current directory is searched first, so a planted binary could run and receive the authorize URL.                  | The browser opener uses absolute paths: `%SystemRoot%\System32\rundll32.exe` and `/usr/bin/open`, plus `/usr/bin/xdg-open` when present. (`src/cli/browser.ts`)                                                                                                                                         |
| L1  | Low        | Setting `NETATMO_MCP_CONFIG_DIR` to a shared folder (home, project) would have re-permissioned that folder: an ACL rewrite or `chmod 0700`.                            | Permissions are changed only on folders this tool created, or that contain only its own files. Otherwise it logs a warning. On POSIX, folders owned by another user are left alone. Probe output folders get the same owner-only protection.                                                            |
| L2  | Low        | Two processes breaking the same stale lock could both enter the critical section.                                                                                      | Stale locks are moved aside atomically and verified. A fresh lock moved by mistake is restored with `link()`. Windows "delete pending" errors (`EPERM`/`EACCES`/`EBUSY`) are treated as contention, not failure. A concurrency stress test confirmed this was a real failure on Windows before the fix. |
| L3  | Low        | The probe sanitizer kept `country`, and missed identifiers embedded in text (error messages, colon-less MACs). Report error lines were not sanitized.                  | `country` is dropped. MACs (any notation) and 24-hex IDs inside strings are replaced consistently, and error lines pass through the sanitizer. The kept time zone is now stated in the report header. `probe/` is git-ignored.                                                                          |
| L4  | Low        | Logger redaction missed some keys (`code` as an OAuth code, `state`, cookies, API keys), form-encoded secrets and binary payloads. There was no actual leak path.      | Key matching is broader. String `code`/`state` values are redacted, while numeric Netatmo error codes are kept. `access_token=…`-style text and binary values are redacted too.                                                                                                                         |
| L5  | Low        | `login` also stores a client secret that came from `NETATMO_CLIENT_SECRET`.                                                                                            | This is by design (MCP configs need no secrets, ADR-0004). It is now stated explicitly when `login` finishes. `logout` deletes it.                                                                                                                                                                      |
| L6  | Low        | Release workflow: npm was installed unpinned in a job with `id-token: write`.                                                                                          | npm is pinned to an exact version. The publish job installs dependencies with `--ignore-scripts`, and the workflow documents the environment protections it expects.                                                                                                                                    |

Informational items also addressed:

- The callback server rejects requests whose `Host` is not a loopback name, which guards against DNS rebinding.
- `login --manual` checks that the pasted URL matches the registered redirect URI.
- A temp file holding secrets is removed if writing it fails.
- Tool string inputs are length-limited (IDs and names ≤ 128 characters, dates ≤ 40).
- `logout` points out remaining probe reports.

## Accepted residual risks

- **Room and home names are returned verbatim.** They are user data
  that the account owner controls. Like any MCP output, they could carry
  prompt-injection text into the assistant. The server has no write
  operations that injected text could trigger.
- **The rate limiter is per process.** Several MCP clients share one
  Netatmo per-user quota. Caching and per-call request caps keep usage
  low.
- **Secrets are stored in plaintext** in an OS-protected file, the same
  model as `gh`, `aws` and `gcloud` ([ADR-0005](adr/0005-token-storage-and-refresh.md)).
- **`state` is visible to local processes.** The authorize URL,
  including `state`, appears briefly in the browser launcher's command
  line. Exchanging a code still requires the client secret.

## Repository settings recommended to the maintainer

These are settings in the GitHub UI and are not configured from code:

- Enable **secret scanning** and **push protection**.
- Enable **private vulnerability reporting** (used by `SECURITY.md`).
- Create the **`npm` environment** with required reviewers, and restrict
  deployment branches to `main` before the first publish.
- Configure **npm trusted publishing** for
  `christophe77/netatmo-energy-mcp` / `release.yml` on npmjs.com.
