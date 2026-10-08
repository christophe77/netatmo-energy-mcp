# Generic MCP client

Most MCP clients accept the common `mcpServers` format:

```json
{
  "mcpServers": {
    "netatmo-energy": {
      "command": "npx",
      "args": ["-y", "netatmo-energy-mcp"]
    }
  }
}
```

- **Transport:** stdio only. Running `netatmo-energy-mcp` with no
  arguments (or `serve`) starts the server. It exits when stdin closes.
- **Logs:** stderr only. stdout carries the MCP protocol.
- **Protocol:** MCP spec 2026-07-28, compatible with 2025 protocol
  versions (official TypeScript SDK v2).
- **Debugging** with the MCP Inspector:

  ```bash
  npx @modelcontextprotocol/inspector --cli npx -y netatmo-energy-mcp --method tools/list
  ```
