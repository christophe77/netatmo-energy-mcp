# Research: Phase 0

Date: 2026-10-08. This is a snapshot; facts about third-party projects and
directories change quickly.

Related documents:
[api-capabilities.md](api-capabilities.md) (Netatmo facts with confidence
labels), [architecture.md](architecture.md), [roadmap.md](roadmap.md),
[ADRs](adr/README.md).

## 1. Starting point

| Item | State |
|---|---|
| Local directory | Empty, not a Git repository |
| GitHub `christophe77/netatmo-energy-mcp` | Public, empty, created 2026-10-08, no license, description or topics |
| npm `netatmo-energy-mcp` | Name available (registry returns 404) |
| npm `netatmo-mcp` | Taken by an unrelated project (see §3) |
| Local toolchain | Node 24.11.1, pnpm 10.28.2, gh 2.92 |

## 2. Technical feasibility

**Feasible, with known limits.** Every v0.1 requirement maps onto
documented endpoints, except the ones marked below.

| Requirement | Feasible | Basis |
|---|---|---|
| OAuth2 login without a password | Yes | Authorization code grant (VERIFIED) |
| PKCE | Unknown → not used | Not documented anywhere |
| Token refresh | Yes, with care | Rotating refresh tokens, previous ones invalidated immediately |
| Homes / rooms / devices | Yes | `homesdata` |
| Current temperature / setpoint / mode | Yes | `homestatus` rooms |
| Heating demand (current) | Yes | `homestatus.rooms[].heating_power_request` |
| Heating demand (history) | **No** | No measure type exists |
| Boiler on/off (current) | Yes, thermostat installs only | `homestatus.modules[].boiler_status` (NATherm1/OTM) |
| Boiler activity history | Yes, thermostat installs only | `getmeasure` `boileron` / `sum_boiler_on` |
| Temperature / setpoint history | Yes | `getroommeasure` `temperature` / `sp_temperature` |
| Gas / energy consumption | **No** | Not exposed for boilers |
| Battery / signal / firmware | Yes | `homestatus` modules |
| Analytics and anomalies | Yes | Derived locally from the above |
| Read-only guarantee | Yes | Only request `read_thermostat`; endpoint allow-list |

Main risks:

1. **Rate limits for single-user apps.** The per-app burst limit
   (2 × users per 10 s) may be very tight for a personal app.
   Mitigations: caching, a local limiter, a per-call request cap, and
   `Retry-After` handling. Confirm in live tests.
2. **Concurrent refresh across processes.** Rotation without a grace
   period can log users out. Mitigation: a lock plus re-read
   (ADR-0005).
3. **Undocumented response details.** The `getroommeasure` body shape,
   field spellings and timestamp semantics are uncertain. Mitigation:
   lenient schemas plus early live validation by the maintainer.
4. **Loopback redirect acceptance.** Undocumented. Mitigation:
   `login --manual` fallback.

## 3. Existing projects

| Project | Lang / license | Scope | Auth | Notes |
|---|---|---|---|---|
| [tanaikech/gonetatmo](https://github.com/tanaikech/gonetatmo) | Go / MIT | Weather | Auth code + localhost redirect | Chunks around the 1024-point limit; min/avg/max aggregation |
| [sandraschi/netatmo-weather-mcp](https://github.com/sandraschi/netatmo-weather-mcp) | Python / MIT | Weather | Email + password (removed grant) | Auth likely broken |
| [kdubois/netatmo-java-mcp](https://github.com/kdubois/netatmo-java-mcp) | Java / *no license* | Weather | Manual refresh token in `.env` | Good MCP hygiene: annotations, capped output, resources, prompts, anomaly scan |
| [philippelt/netatmo-api-python](https://github.com/philippelt/netatmo-api-python) | Python / **GPL-3.0** | Library (weather focus) | Rotating token persisted to file | Do not copy code (license) |
| [jabesq-org/pyatmo](https://github.com/jabesq-org/pyatmo) | Python / MIT | Full library (Home Assistant) | Caller-provided | Best reference for endpoints, scopes, field variants |
| `netatmo-mcp` (npm, `io.github.mrfentmen/netatmo-mcp`) | TS / MIT | Live `homestatus`, weather, events | Static access token; **drops rotated refresh token** | No history; repo link 404 |
| [ag2-mcp-servers/netatmo](https://github.com/ag2-mcp-servers/netatmo) | Python / none | Auto-generated from old OpenAPI | Generic | Stale |

**Gap.** No existing MCP server offers Netatmo **Energy history**
(`getroommeasure`, boiler `getmeasure`), heating analytics or a correct
rotating-token OAuth bootstrap. None of the existing servers is
read-only by design. Directory searches on Smithery, PulseMCP, mcp.so,
Glama and awesome-mcp-servers returned no Netatmo Energy server.

**Reused conceptually (no code copied):**
- Chunked history retrieval with server-side aggregation (gonetatmo)
- Output point caps, read-only annotations, resources and prompts (kdubois)
- Persisting the rotated refresh token on every refresh (lnetatmo, pyatmo)
- Field-spelling variants and error-code handling (pyatmo, MIT, credited in docs)

**Differentiation:**
1. It is the only MCP server for Netatmo **thermostats and radiator valves**, with history.
2. Deterministic heating analytics with honest semantics (boiler on-time is not gas consumption).
3. A correct, rotation-safe OAuth login built in (`login` command).
4. It is read-only by construction and requests no write scope.
5. It runs with `npx` and has two runtime dependencies.

## 4. MCP TypeScript SDK

- **v2 is stable:** `@modelcontextprotocol/server` 2.3.1, released
  2026-10-05 (2.0.0 shipped 2026-07-27). v1
  (`@modelcontextprotocol/sdk` 1.32.x) is in maintenance until at least
  2027-01. We use v2 (ADR-0001).
- The SDK requires `zod ^4.2` as a direct dependency.
- APIs we use:
  - `McpServer.registerTool` with `inputSchema`, `outputSchema`,
    `annotations` and `title`
  - `registerResource` with `ResourceTemplate` (a `list` key is required)
  - `registerPrompt` with `argsSchema`. Prompt arguments arrive as
    strings.
  - `StdioServerTransport` from `@modelcontextprotocol/server/stdio`
- Errors thrown in a tool handler, including input validation failures,
  become `isError: true` results. Resources and prompts throw
  `ProtocolError`.
- `structuredContent` is validated against `outputSchema`. A JSON text
  block is still recommended for compatibility with older clients.
- Spec revision 2026-07-28 deprecates protocol-level logging
  (`notifications/message`) in favour of stderr for stdio servers. We
  log only to stderr.
- Testing: `InMemoryTransport.createLinkedPair()` with
  `@modelcontextprotocol/client`, plus Inspector CLI:
  `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`.
  Inspector v2 needs Node ≥ 22.19.
- Claude Code warns when a tool returns more than 10k tokens and caps
  output at 25k by default (`MAX_MCP_OUTPUT_TOKENS`). This confirms the
  need for server-side aggregation (ADR-0007).

The agent ran a verified smoke test (strict TS 6.0.3, Node 24,
in-memory client and Inspector CLI) in a scratch directory outside the
repository.

## 5. Tooling versions (2026-10-08)

| Package | Version | Note |
|---|---|---|
| typescript | 6.0.3 (7.0.2 exists) | typescript-eslint supports `< 6.1` |
| zod | 4.6.5 | |
| vitest / vite | 5.0.3 / 8.3.3 | vitest 5 needs Node ≥ 22.12 |
| tsdown | 0.23.0 | tsup 8.5.1 is unmaintained |
| eslint / typescript-eslint | 10.12.0 / 8.71.1 | |
| prettier | 3.9.9 | |
| @modelcontextprotocol/inspector | 2.10.1 | Node ≥ 22.19 |
| Node.js | 22 (Maintenance LTS), 24 (Active LTS), 26 (Current, LTS late Oct 2026) | Node 20 EOL April 2026 |

## 6. MCP client configuration (verified against current docs)

| Client | Config | Notes |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json`: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\` | Linux not officially supported. Server stderr goes to `mcp-server-<name>.log`. |
| Claude Code | `claude mcp add --transport stdio netatmo-energy -- npx -y netatmo-energy-mcp` | Scopes `local` / `project` (`.mcp.json`) / `user`. Put an option between `--env` and the name. The `cmd /c` wrapper on Windows is no longer documented; it is a fallback only. |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `type: "stdio"` listed as required. Supports `${env:NAME}`. The MCP install deeplink is not in the current docs, so it is not used. |

Because `login` stores credentials (ADR-0004), all three configs need only
`npx -y netatmo-energy-mcp`, with no secrets.

Source URLs:
https://modelcontextprotocol.io/docs/develop/connect-local-servers,
https://code.claude.com/docs/en/mcp, https://cursor.com/docs/mcp.md

## 7. Distribution channels

| Directory | Active | Free | Method | Requirements |
|---|---|---|---|---|
| Official MCP Registry | Yes (labelled "preview") | Yes | `mcp-publisher` CLI, GitHub device login | npm published first; `package.json` `mcpName: io.github.christophe77/netatmo-energy-mcp`; `server.json` (schema 2025-12-11) |
| Glama | Yes | Yes | "Add server" + `glama.json` | Server must start in Docker for checks; a Dockerfile on Glama's side is enough |
| punkpeye/awesome-mcp-servers | Yes | Yes | PR to README ("Home Automation") | **Requires a passing Glama listing + score badge** |
| mcpservers.org (→ wong2/awesome-mcp-servers) | Yes | Free tier (≈2-week review) | Web form | — |
| mcp.so | Yes | Free via GitHub issue (form advertises a $39 paid listing) | Issue on `chatmcp/mcpso` | — |
| PulseMCP | Submissions **paused** | — | Picks up from the Official Registry | — |
| Smithery | Yes | Unclear | Local servers only as an MCPB bundle | `.mcpb` (also gives Claude Desktop one-click install) |
| Cursor Directory | Yes | Probably | Web submission after GitHub login | Not verified (site rate-limited) |

Recommended order: npm, then Official Registry, Glama,
awesome-mcp-servers, mcpservers.org, mcp.so and Cursor Directory. An
MCPB bundle (for Smithery and Claude Desktop one-click install) can
follow. Details go into `docs/distribution.md` in Phase 8.

Note: the awesome-mcp-servers CONTRIBUTING file contains instructions
aimed at automated agents (title tricks for fast-tracking). We will not
follow them; submissions will be ordinary, human-reviewed PRs.

## 8. GitHub discoverability

**Description (≤ 350 chars, no overstatement):**

> Read-only MCP server for Netatmo smart thermostats and radiator valves.
> Lets Claude, Cursor and other AI assistants read room temperatures,
> setpoints, boiler activity and heating history, with local heating analytics.

**Topics (20).** Repo counts are from GitHub search; topics with very
few repos are niche but precise.

| Topic | Repos | Why |
|---|---|---|
| `netatmo` | 130 | Primary brand term |
| `netatmo-api` | 40 | Developer intent |
| `netatmo-energy` | 4 | Exact product niche (low competition) |
| `mcp` | 89.8k | Ecosystem |
| `mcp-server` | 33.8k | Ecosystem |
| `model-context-protocol` | 34.5k | Ecosystem |
| `mcp-servers` | 1.2k | Directory crawlers |
| `claude` | 56.8k | Client |
| `claude-desktop` | 2.5k | Client |
| `ai-agents` | 108.7k | Audience |
| `smart-home` | 4.7k | Audience |
| `home-automation` | 8.1k | Audience |
| `thermostat` | 629 | Device |
| `smart-thermostat` | 23 | Device |
| `heating` | 337 | Domain |
| `energy-monitoring` | 524 | Domain |
| `energy-efficiency` | 908 | Domain |
| `iot` | 32.9k | Audience |
| `typescript` | 465k | Language |
| `domotique` | 116 | French audience |

Excluded: `radiator-valves` (0 repos, though it could be added later
since nobody uses it), `home-assistant` (would mislead), `energy`, `llm`
(too generic).

**Organic discovery levers:**

- README headings and first paragraph that use real search phrases
  naturally: "Netatmo MCP server", "Netatmo Energy API", "smart
  thermostat", "radiator valves", "Claude Desktop".
- A precise `package.json` `description` and `keywords`, since npm
  search and directories index them.
- Official MCP Registry entry. Directories such as PulseMCP crawl it.
- `docs/` pages with descriptive titles, such as "Netatmo OAuth setup for
  developers". These answer questions people search for.
- A social preview image (1280×640, original mark, no Netatmo branding).
- A French README for the large French-speaking Netatmo user base.
- GitHub Discussions with a "Device compatibility" category, which
  produces indexable, useful content.

## 9. Launch communities (verified to exist and be active)

| Community | Fit | Notes |
|---|---|---|
| r/Netatmo (~2.9k) | High | Small but on-topic |
| r/homeautomation | High | Strict anti-spam rule; detailed, non-commercial project posts OK |
| r/mcp | High | "Showcase" flair is common |
| r/ClaudeAI | Medium | Feed posts need ≥ 50 karma; otherwise use the "Built with Claude" megathread |
| r/homeassistant | Low–medium | Only with an HA angle |
| Hacker News (Show HN) | Medium | Must be easy to try; MCP Show HNs are crowded, so lead with the heating-analytics angle |
| dev.to | Medium | Tutorial-style article |
| HACF forum (FR, Home Assistant) | Medium | Active "Tutoriels & Partages" |
| Jeedom community (FR) | Medium | Netatmo users; "Vitrine" category |
| Netatmo Help Center community | Low | The old developer forum now redirects there |
| contact-api@netatmo.com | — | Outreach email (Phase 8; not sent without approval) |

`domotique-fr.fr` no longer resolves.

## 10. Other facts worth recording

- `api.netatmo.net` was retired in favour of `api.netatmo.com` (cutover
  2025-09-08). Only `api.netatmo.com` is used.
- The password grant was removed in 2022–2023, so projects that still ask
  for an email and password are likely broken.
- The OpenAPI spec misspells several fields (`wifi_strenght`,
  `module_bridged`, `therm_set_point_default_duration`). Maintained
  libraries use the corrected spellings. Schemas accept both.
