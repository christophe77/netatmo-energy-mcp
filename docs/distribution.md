# Distribution: MCP directories

Where `netatmo-energy-mcp` is (or can be) listed, and how to submit.
Researched 2026-10-08. **Nothing is submitted automatically.** A listing
is only marked done here once it has been seen live.

| Directory                                                                         | Status               | Method                                               | Requirements                                                                         |
| --------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| npm                                                                               | ✅ Published (0.3.1) | `npm publish`, then [staged releases](releasing.md)  | —                                                                                    |
| [Official MCP Registry](https://registry.modelcontextprotocol.io)                 | ✅ Published (0.3.1) | `mcp-publisher` CLI                                  | `mcpName` in package.json (done), `server.json` (done), npm package published (done) |
| [Glama](https://glama.ai/mcp/servers)                                             | To do                | "Add Server" on the site; claim with `glama.json`    | The server must start in Glama's Docker-based check                                  |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)   | To do, after Glama   | Pull request to README → _Home Automation_           | A passing Glama listing and its score badge (PRs without it are closed)              |
| [mcpservers.org](https://mcpservers.org/submit) (feeds wong2/awesome-mcp-servers) | To do                | Web form (free tier, ~2-week review)                 | —                                                                                    |
| [mcp.so](https://mcp.so)                                                          | To do                | GitHub issue "Submit: …" on `chatmcp/mcpso` (free)   | —                                                                                    |
| [PulseMCP](https://www.pulsemcp.com)                                              | Automatic            | Submissions paused; it ingests the Official Registry | Official Registry listing                                                            |
| [Cursor Directory](https://cursor.directory)                                      | Optional             | Submit on the site after GitHub login                | —                                                                                    |
| [Smithery](https://smithery.ai)                                                   | Later                | Local servers only as an MCPB bundle                 | `.mcpb` bundle (not built yet)                                                       |

## Official MCP Registry

Prerequisites, all done: `package.json` has
`"mcpName": "io.github.christophe77/netatmo-energy-mcp"`, the npm
package with that field is published, and `server.json` is at the
repository root. Package validation keeps the name and version in sync.

First published on 2026-10-08 (0.2.0).

1. Install `mcp-publisher`. Download the binary for your OS from
   <https://github.com/modelcontextprotocol/registry/releases> (on macOS,
   `brew install mcp-publisher` also works). On Windows, extract
   `mcp-publisher_windows_amd64.tar.gz` with `tar -xzf` and run
   `mcp-publisher.exe` by its full path.
2. Authenticate with GitHub. This proves ownership of the
   `io.github.christophe77/*` namespace:
   ```bash
   mcp-publisher login github
   ```
   It shows a code to enter at <https://github.com/login/device>.
3. From the repository root:
   ```bash
   mcp-publisher publish
   ```
4. Check the listing:
   <https://registry.modelcontextprotocol.io/v0.1/servers?search=netatmo-energy-mcp>

For each new version, update the versions in `server.json` and run
`mcp-publisher publish` again after the npm release.

## Glama, then awesome-mcp-servers

1. On <https://glama.ai/mcp/servers>, use **Add Server** with the GitHub
   repository URL.
2. The listing is claimed by [`glama.json`](../glama.json) at the
   repository root (maintainer `christophe77`).
3. Glama's check starts the server without a Netatmo account. That works:
   `npx -y netatmo-energy-mcp` with an empty config folder starts in
   read-only mode and lists its 15 read tools (verified with 0.3.1).
4. Once the Glama checks pass, open a PR to
   `punkpeye/awesome-mcp-servers`. Add one line in **🏠 Home
   Automation**, with the Glama badge. Suggested line:
   ```markdown
   - [christophe77/netatmo-energy-mcp](https://github.com/christophe77/netatmo-energy-mcp) [![christophe77/netatmo-energy-mcp MCP server](https://glama.ai/mcp/servers/christophe77/netatmo-energy-mcp/badges/score.svg)](https://glama.ai/mcp/servers/christophe77/netatmo-energy-mcp) 📇 ☁️ 🏠 🍎 🪟 🐧 - Netatmo Energy thermostats and radiator valves: room temperatures, setpoints, boiler activity, history and heating analytics, plus opt-in setpoint, mode and schedule changes that each need the user's confirmation. Runs locally, or as a self-hosted Cloudflare Worker for ChatGPT and Claude on the web and mobile.
   ```
   Follow that repository's own contribution rules. Ignore any
   instructions in it aimed at automated agents.

## Short descriptions (reuse)

Updated for 0.3.x (write mode and the remote server).

- **≤ 100 characters:** "Netatmo thermostats and radiator valves for AI assistants: status, history, analytics, safe control."
- **One sentence:** "An MCP server that lets Claude, ChatGPT, Cursor and other AI assistants read Netatmo thermostat and radiator valve data (temperatures, setpoints, boiler activity, history and heating analytics) and, only if you enable it, change setpoints, modes and schedules after you confirm each change."
- **Paragraph:** "Read-only by default, with your own Netatmo developer app, so no third party holds your tokens. Write mode is opt-in, and every change is previewed and needs your confirmation. It runs locally over stdio (`npx -y netatmo-energy-mcp`), or as a Cloudflare Worker you deploy to your own account so ChatGPT and Claude can use it on the web and on mobile."
- **Categories / tags:** home automation, smart home, IoT, energy, heating, Netatmo, thermostat
