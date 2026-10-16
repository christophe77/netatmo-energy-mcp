# Privacy policy

Last updated: 2026-10-16

This policy covers the open-source **netatmo-energy-mcp** software: the
npm package, the Claude Code plugin `netatmo-energy` (MCP server and
skill) and the remote server in `remote/` when you deploy it yourself.
It is published by the maintainer, christophe77. This project is not
affiliated with Netatmo.

**In short:** the maintainer runs no server and receives none of your
data. The software runs on your computer, or on your own Cloudflare
account, and talks only to Netatmo with your own credentials.

## 1. Data collection

The maintainer collects no data: no telemetry, no analytics, no crash
reports, no account.

The software itself handles:

- **Your Netatmo developer app credentials** (client ID and secret) and
  the **OAuth tokens** Netatmo issues when you log in.
- **Heating data** that Netatmo returns: homes, rooms, devices,
  temperatures, setpoints, schedules, boiler activity, battery and signal
  levels.
- In write mode, a **local log of the heating changes** it applied.

It never requests or returns your email address or your home's
coordinates.

## 2. Use and storage

**Local server and Claude Code plugin.**

- Credentials and tokens are stored in `credentials.json` in your user
  configuration folder (`%APPDATA%\netatmo-energy-mcp` on Windows,
  `~/Library/Application Support/netatmo-energy-mcp` on macOS,
  `~/.config/netatmo-energy-mcp` on Linux), readable only by your user
  account.
- Heating data is used only to answer the request that asked for it.
  It is cached in memory for a few minutes (topology 10 minutes, current
  status 30 seconds) and never written to disk.
- In write mode, `changes.log` in the same folder gets one line per
  change: time, action, parameters sent and outcome.
- The diagnostic command `probe`, only if you run it, writes API
  responses (sanitized unless you pass `--raw`) to `probe/<timestamp>/`
  in that folder, or to the folder given with `--out`.

**Remote server you deploy yourself.** Credentials and tokens are stored
encrypted (AES-GCM) in **your** Cloudflare account, with the keys you set
as Worker secrets. Its request logs, visible only in your Cloudflare
dashboard, contain the client, method, status and size of each request,
never secrets, tokens, arguments or results.

## 3. Third-party sharing

- **Netatmo.** The software sends HTTPS requests to `api.netatmo.com`
  with your tokens. Netatmo's own privacy policy applies to that data.
- **Your AI assistant.** Tool results are read by the assistant you use
  (for example Claude), so they are processed by that provider under its
  own terms.
- **npm.** `npx` downloads the package from the npm registry, which
  sees a normal package download.
- **Cloudflare**, only if you deploy the remote server, as the host of
  your own deployment.

Nothing is sold, and nothing is sent to the maintainer or any other
party.

## 4. Data retention

- Local credentials and tokens stay until you run
  `npx -y netatmo-energy-mcp logout`, which deletes them, or delete the
  configuration folder.
- `changes.log` and `probe/` output stay until you delete them.
- In-memory caches end when the server stops.
- On a remote server you deployed, data stays until you remove it:
  `remote remove` erases an onboarded account, and deleting the Worker
  and its storage erases everything.
- To revoke access on Netatmo's side, remove the app's access in your
  Netatmo account settings or delete your developer app at
  <https://dev.netatmo.com/apps>.

## 5. Children

The software is not directed at children under 18.

## 6. Changes

Changes to this policy are made in this file and visible in the
repository history.

## 7. Contact

- Questions: <https://github.com/christophe77/netatmo-energy-mcp/issues>
- Security or privacy issues, privately:
  <https://github.com/christophe77/netatmo-energy-mcp/security/advisories/new>
