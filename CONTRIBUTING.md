# Contributing

Thanks for helping improve Netatmo Energy MCP. Bug reports, device
compatibility reports, documentation fixes and pull requests are all
welcome.

## Ground rules

- **Read-only by default is a hard rule.**
  - Read features must work with the `read_thermostat` scope alone.
  - Anything that changes heating goes through the opt-in write mode
    ([ADR-0012](docs/adr/0012-opt-in-write-mode.md)): `ControlService`,
    the confirmation flow in `src/mcp/confirm.ts`, the configured limits
    and the audit log. Never call `client.write()` from anywhere else.
  - New write endpoints need an ADR update first. `setstate` stays out.

  Tests enforce the separation (`tests/unit/netatmo/read-only.test.ts`).

- **Never commit real data.** That means home IDs, device MAC addresses,
  room names, addresses, coordinates, tokens or real heating histories.
  Test fixtures are synthetic or sanitized
  ([tests/fixtures/README.md](tests/fixtures/README.md)).
- **No invented API behaviour.** If you rely on a Netatmo field or
  behaviour, document where it comes from in
  [docs/api-capabilities.md](docs/api-capabilities.md): the official
  docs, a maintained library, or a dated live observation.
- **Honest semantics.** Never present heat-demand time as energy or gas
  consumption, and never present an anomaly as a diagnosed fault
  ([ADR-0009](docs/adr/0009-honest-analytics.md)).
- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node.js ≥ 22.19 and pnpm 10.

```bash
git clone https://github.com/christophe77/netatmo-energy-mcp.git
cd netatmo-energy-mcp
pnpm install
pnpm check   # typecheck, lint, format check, tests
pnpm build
```

The test suite uses mocked Netatmo responses and needs no Netatmo
account.

| Script                                         | Purpose                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:watch`                | Unit, integration and MCP protocol tests                                                       |
| `pnpm test:coverage`                           | Tests with coverage thresholds, as in CI                                                       |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | TypeScript, ESLint, Prettier                                                                   |
| `pnpm build`                                   | Bundle `dist/index.js` with tsdown                                                             |
| `pnpm docs:tools`                              | Regenerate [docs/tools.md](docs/tools.md) from the built server. Run it after changing a tool. |
| `pnpm check:package`                           | Pack the npm tarball, install it and talk MCP to it                                            |

To try the server against your own account, use the local build. Inside this
repository, `npx netatmo-energy-mcp` resolves the local `package.json` and fails:

```bash
node dist/index.js login
node dist/index.js doctor
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

## Project layout

| Path             | What lives there                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `src/netatmo/`   | API client: read allow-list, guarded opt-in writes, retries, rate limiter, schemas            |
| `src/auth/`      | OAuth, credential store, cross-process lock, token refresh                                    |
| `src/domain/`    | Application services (EnergyService, AnalyticsService, ControlService) and views; no MCP code |
| `src/analytics/` | Pure analytics functions                                                                      |
| `src/mcp/`       | Tool, resource and prompt registration only                                                   |
| `src/cli/`       | CLI commands                                                                                  |

Architecture: [docs/architecture.md](docs/architecture.md). Design
decisions: [docs/adr/](docs/adr/README.md).

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can
   agree on the approach.
2. Keep changes focused, and add tests: the CI coverage thresholds must
   stay green.
3. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(mcp): …`, `fix(auth): …`, `docs: …`.
4. If you change tool names, inputs or outputs, update
   `docs/tools.md` (`pnpm build && pnpm docs:tools`) and the README
   table. Then note the change in `CHANGELOG.md` under _Unreleased_.
5. Do not add runtime dependencies without a short justification
   ([ADR-0006](docs/adr/0006-minimal-runtime-dependencies.md)).

## Releases

Maintainers: see [docs/releasing.md](docs/releasing.md).

## Reporting device compatibility

If you have equipment not listed as tested (OpenTherm `OTM`/`OTH`,
BTicino, …):

1. Run `npx -y netatmo-energy-mcp probe`.
2. Read `report.md`. It is sanitized: IDs and names are replaced, and
   location data is removed.
3. Open a **Device compatibility report** issue with its content.

## Security issues

Please do **not** open public issues for vulnerabilities. See
[SECURITY.md](SECURITY.md).
