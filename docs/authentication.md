# Authentication

`netatmo-energy-mcp` uses Netatmo's official OAuth2 **authorization code**
flow. You sign in on netatmo.com in your browser; this tool never sees
your Netatmo password. It requests only the read-only `read_thermostat`
scope, so it cannot change your heating.

## 1. Create your Netatmo developer app

Netatmo requires a client secret to obtain and refresh tokens. An
open-source local tool cannot ship a shared secret, so each user creates
their own free app ([ADR-0004](adr/0004-bring-your-own-netatmo-app.md)).

1. Sign in at <https://dev.netatmo.com/apps> with your Netatmo account and
   choose **Create**.
2. Fill in the form. Only you will see this app.
   - **Name / description**: anything, e.g. "My heating MCP".
   - **Website, organization, data protection officer**: the portal may
     ask for these. Your own name, email and any personal URL are fine
     for a private app.
   - **Redirect URI**: `http://localhost:8977/callback`
3. Save, then note the **client ID** and **client secret**.

> The portal hides its "generate token" helper once an app has a redirect
> URI. You don't need that helper: `login` does the full flow.

## 2. Log in

```bash
npx -y netatmo-energy-mcp login
```

`login` asks for the client ID and secret (the secret is not echoed).
Alternatively, set `NETATMO_CLIENT_ID` and `NETATMO_CLIENT_SECRET` first.
Then:

1. A local callback server starts on `localhost:8977`. It accepts loopback
   connections only and closes after one use or after 5 minutes.
2. Your browser opens Netatmo's authorization page.
3. After you approve, Netatmo redirects to the callback. The tool checks
   the one-time `state` value, exchanges the code for tokens, and saves
   them.

### Headless machines, or if the redirect fails

```bash
npx -y netatmo-energy-mcp login --manual
```

Open the printed URL in any browser and approve access. Your browser is
then redirected to `http://localhost:8977/callback?...`. That page may
fail to load, which is expected. Copy the full URL from the address bar
and paste it into the terminal.

### Using a different redirect URI

Set `NETATMO_REDIRECT_URI` to exactly the value registered in your app,
for example `http://127.0.0.1:9000/callback`. The automatic flow needs an
`http://` loopback address (`localhost`, `127.0.0.1` or `[::1]`). Any
other URI works with `--manual`.

## 3. Check

```bash
npx -y netatmo-energy-mcp status
npx -y netatmo-energy-mcp doctor
```

Neither command prints tokens or secrets.

## Where credentials are stored

| OS      | File                                                                    |
| ------- | ----------------------------------------------------------------------- |
| Windows | `%APPDATA%\netatmo-energy-mcp\credentials.json`                         |
| macOS   | `~/Library/Application Support/netatmo-energy-mcp/credentials.json`     |
| Linux   | `~/.config/netatmo-energy-mcp/credentials.json` (or `$XDG_CONFIG_HOME`) |

Override the folder with `NETATMO_MCP_CONFIG_DIR`.

The file contains your app's client ID and secret and the current
access and refresh tokens.

- **macOS / Linux**: folder `0700`, file `0600`, so only your user can
  read them.
- **Windows**: when the folder is created, its access list is restricted
  to your user account and `SYSTEM` (plus Administrators if created from an
  elevated terminal), with inheritance removed. Files
  inside inherit that restriction. `doctor` shows the current access list.
- Updates are atomic (written to a temp file, then renamed), so the file
  is never left half-written.

Environment variables `NETATMO_CLIENT_ID` and `NETATMO_CLIENT_SECRET`
**take precedence** over the stored values. If the environment points
to a different app than the one that issued the stored tokens, you'll
be asked to log in again, because tokens only work with the app that
issued them.

## Token refresh

Access tokens last about 3 hours and are refreshed automatically.
Netatmo **rotates** the refresh token on every refresh and immediately
invalidates the old one. If you run several MCP clients (each starts its
own server process), they coordinate through a lock file
(`credentials.lock`), so only one process refreshes and the others pick
up the new tokens. Details are in
[ADR-0005](adr/0005-token-storage-and-refresh.md).

If a refresh is interrupted at exactly the wrong moment (after Netatmo
has issued new tokens but before they are saved), the old refresh token
is already invalid on Netatmo's side and you'll need to run `login`
again. The tool keeps that window as short as possible.

## Logging out

```bash
npx -y netatmo-energy-mcp logout
```

This deletes the local credentials file. Netatmo has no documented token
revocation endpoint. To revoke access on Netatmo's side too, delete the
app (or regenerate its secret) at <https://dev.netatmo.com/apps>.

## Troubleshooting

| Message                             | Meaning / fix                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`             | The redirect URI in your app settings differs from the one used by `login`. They must match exactly, including port and path.                                     |
| `invalid_client`                    | Wrong client ID or secret. Copy them again from dev.netatmo.com.                                                                                                  |
| Port 8977 already in use            | Close the other program, use `--manual`, or choose another URI with `NETATMO_REDIRECT_URI`.                                                                       |
| "rejected the stored refresh token" | The token expired, was revoked, or was used by another tool configured with the same app. Run `login` again. Avoid sharing one Netatmo app between several tools. |
