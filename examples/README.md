# MCP client configuration examples

`netatmo-energy-mcp` is a local **stdio** MCP server. Every client below
starts it with `npx -y netatmo-energy-mcp`. Run
`npx -y netatmo-energy-mcp login` once first. After that, the client
configuration needs **no secrets**.

| Client               | Example                            |
| -------------------- | ---------------------------------- |
| Claude Desktop       | [claude-desktop/](claude-desktop/) |
| Claude Code          | [claude-code/](claude-code/)       |
| Cursor               | [cursor/](cursor/)                 |
| Any other MCP client | [generic/](generic/)               |

Configuration formats were checked against each client's documentation
on 2026-10-08. Clients change; if something no longer matches, please
open an issue.

## Running from a local build

To run a clone instead of the npm package:

```json
{ "command": "node", "args": ["/absolute/path/to/netatmo-energy-mcp/dist/index.js"] }
```

On Windows, escape backslashes in JSON:
`"C:\Users\you\netatmo-energy-mcp\dist\index.js"`.

## Environment variables (optional)

Clients can pass environment variables in an `env` object. Useful ones:

| Variable                                      | Purpose                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `NETATMO_MCP_LOG_LEVEL`                       | `debug`, `info` (default), `warn`, `error`, `silent`. Logs go to the client's MCP log, never to the protocol stream. |
| `NETATMO_MCP_CONFIG_DIR`                      | Use a different configuration folder                                                                                 |
| `NETATMO_CLIENT_ID` / `NETATMO_CLIENT_SECRET` | Override the stored app credentials. Not needed after `login`.                                                       |

See [docs/configuration.md](../docs/configuration.md).
