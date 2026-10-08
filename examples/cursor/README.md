# Cursor

1. Run `npx -y netatmo-energy-mcp login` once in a terminal.
2. Add the entry from [mcp.json](mcp.json) to one of these files:
   - `~/.cursor/mcp.json` (all projects), or
   - `.cursor/mcp.json` in a project. The project file wins when both
     define `netatmo-energy`.
3. Enable the server under **Cursor Settings → MCP** and check that its
   tools are listed.

Cursor can read variables from your environment, for example
`"env": { "NETATMO_MCP_LOG_LEVEL": "${env:NETATMO_MCP_LOG_LEVEL}" }`.
