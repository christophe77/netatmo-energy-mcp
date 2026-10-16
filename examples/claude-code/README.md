# Claude Code

Run `npx -y netatmo-energy-mcp login` once, then add the server for your
user (available in every project):

```bash
claude mcp add --transport stdio --scope user netatmo-energy -- npx -y netatmo-energy-mcp
```

Everything after `--` is the command Claude Code runs. Check it with:

```bash
claude mcp list
```

To share the configuration in a repository instead, commit a project
`.mcp.json`, like [this example](.mcp.json). Claude Code asks each user
to approve project servers.

Optional environment variables go before the name. Keep an option
between `--env` and the server name:

```bash
claude mcp add --transport stdio --env NETATMO_MCP_LOG_LEVEL=debug --scope user netatmo-energy -- npx -y netatmo-energy-mcp
```

On native Windows, if the server fails to start through `npx`, try
`-- cmd /c npx -y netatmo-energy-mcp`.

## Plugin

The repository is also a Claude Code plugin marketplace. The
`netatmo-energy` plugin installs the same server, pinned to the release
it ships with (`npx -y netatmo-energy-mcp@<version>`), plus a
`netatmo-energy` skill: which tool to call
for which question, how to investigate a cold or overheated room, report
and comparison formats, and the preview-and-confirm steps for heating
changes.

Run `npx -y netatmo-energy-mcp login` once, then inside Claude Code:

```text
/plugin marketplace add christophe77/netatmo-energy-mcp
/plugin install netatmo-energy@netatmo-energy-mcp
```

Restart Claude Code when asked. Pick one setup: if you already added the
server with `claude mcp add`, remove it
(`claude mcp remove netatmo-energy --scope user`) so the tools are not
listed twice.

The plugin's server takes no environment variables. For options such as
`NETATMO_MCP_CONFIRM` or `NETATMO_MCP_WRITE=0`, keep the
`claude mcp add` setup above.

Sources: [plugins/netatmo-energy](../../plugins/netatmo-energy).
