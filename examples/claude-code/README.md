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
