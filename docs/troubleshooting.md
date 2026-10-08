# Troubleshooting

Start with:

```bash
npx -y netatmo-energy-mcp doctor
```

It checks Node.js, folder permissions, credentials, token refresh and API
access, and never prints secrets.

## Login

| Symptom                                   | Fix                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` on netatmo.com    | Your app's redirect URI must be exactly `http://localhost:8977/callback`, or the value of `NETATMO_REDIRECT_URI`. |
| `invalid_client`                          | The client ID or secret is wrong. Copy them again from <https://dev.netatmo.com/apps>.                            |
| "Port 8977 is already in use"             | Close the other program, set another `NETATMO_REDIRECT_URI` (and register it), or use `login --manual`.           |
| The browser does not open                 | Copy the printed URL into a browser, or use `login --no-browser`.                                                 |
| Headless machine or SSH session           | Use `login --manual` and paste the URL your browser ends up on.                                                   |
| "The OAuth state parameter did not match" | You used an old authorization link. Start `login` again and use the newest link.                                  |

## In the MCP client

Tool errors carry a `code` and a `hint`:

| Code                     | Meaning                                                                                     | What to do                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AUTH_REQUIRED`          | Not logged in, or the token was revoked or expired                                          | Run `netatmo-energy-mcp login`.                                                                   |
| `PERMISSION_DENIED`      | The token lacks `read_thermostat`                                                           | Run `login` again and accept the requested access.                                                |
| `RATE_LIMITED`           | Too many requests, locally or at Netatmo                                                    | Wait a few minutes, or ask for a shorter range or coarser scale.                                  |
| `NOT_FOUND`              | Unknown home, room or device                                                                | Ask the assistant to list rooms or devices first. Room names are matched without case or accents. |
| `INVALID_ARGUMENT`       | Bad date, range too long, etc.                                                              | The message says what to change.                                                                  |
| `UNSUPPORTED_CAPABILITY` | The installation cannot provide this data, e.g. boiler history without a Netatmo thermostat | Nothing to fix: the data does not exist.                                                          |
| `NETATMO_UNAVAILABLE`    | Network or Netatmo server problem                                                           | Try again later.                                                                                  |
| `INVALID_RESPONSE`       | Netatmo returned an unexpected format                                                       | Please open an issue with a `probe` report.                                                       |

**The server does not start in the client**

- Run `npx -y netatmo-energy-mcp --version` in a terminal.
- Check the client's MCP logs. Server logs go to stderr; for Claude
  Desktop they are in `mcp-server-netatmo-energy.log`.
- On Windows, see the `npx` notes in
  [examples/claude-desktop](../examples/claude-desktop/README.md).

**More detail in the logs.** Set `NETATMO_MCP_LOG_LEVEL=debug` in the
client's `env` block. Tokens and secrets are redacted.

## Several MCP clients at once

That is supported. The processes share the credentials file and
coordinate token refreshes with `credentials.lock`. If a process crashed
while holding the lock, the lock is treated as stale after 30 s. If you
ever see "Timed out waiting for another netatmo-energy-mcp process" and
no other process is running, delete `credentials.lock` from the
configuration folder.

## Reporting a problem

Run `npx -y netatmo-energy-mcp probe` and attach `report.md`. It contains
no IDs, names or location data. Then open an issue. Never attach
`credentials.json` or `responses.raw.json`.
