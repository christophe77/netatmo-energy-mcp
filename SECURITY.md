# Security policy

## Supported versions

| Version            | Supported           |
| ------------------ | ------------------- |
| Latest 0.x release | ✅                  |
| Older releases     | ❌ (please upgrade) |

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**:
   <https://github.com/christophe77/netatmo-energy-mcp/security/advisories/new>.

Please include:

- affected version and OS
- steps to reproduce, or a proof of concept
- the impact you expect, for example a token leak, a write to the
  Netatmo API, or local privilege issues

You will get an acknowledgement within 7 days. Once the issue is
understood, we will agree on a fix and disclosure timeline with you.
Reporters are credited unless they prefer otherwise.

Never include real Netatmo tokens, client secrets or unsanitized account
data in a report. If a secret was exposed, revoke it first: delete or
regenerate your app at <https://dev.netatmo.com/apps>.

## Scope

In scope:

- Anything that could make the server **change heating settings**. The
  project must be read-only.
- **Leaks of tokens, client secrets or account data** through output,
  logs, files or errors.
- **Weaknesses in the OAuth login** (state handling, loopback callback)
  or in credential storage (permissions, atomicity, locking).
- **Access to data or hosts** beyond `api.netatmo.com`.

Out of scope:

- Vulnerabilities in Netatmo's own services. Report those to Netatmo.
- Issues that require an attacker who already controls the user's
  account or machine.

## Security design

- Read-only by construction: only the `read_thermostat` scope, plus an
  allow-list of read endpoints.
- No network listener except the short-lived loopback login callback.
- No telemetry.
- Owner-only credential storage.

Details are in [docs/architecture.md](docs/architecture.md#10-security-model).
Past reviews are in [docs/security-review.md](docs/security-review.md).
