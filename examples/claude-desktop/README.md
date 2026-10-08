# Claude Desktop

1. Run `npx -y netatmo-energy-mcp login` once in a terminal.
2. In Claude Desktop, open **Settings → Developer → Edit Config**. This
   opens `claude_desktop_config.json`:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Merge the `mcpServers` entry from
   [claude_desktop_config.json](claude_desktop_config.json) into it.
4. Restart Claude Desktop. The `netatmo-energy` tools appear in the tools
   menu.

Notes:

- **Logs.** Server logs are written by Claude Desktop to `mcp-server-netatmo-energy.log`:
  - macOS: `~/Library/Logs/Claude/`
  - Windows: `%APPDATA%\Claude\logs\`
- **`npx` not found (Windows).** Make sure Node.js is installed for your
  user and `npx` works in a new terminal. If Claude Desktop still cannot
  start it, use the absolute path to `npx.cmd`, or install globally
  (`npm install -g netatmo-energy-mcp`) and set
  `"command": "netatmo-energy-mcp"` with `"args": []`.
- **Linux.** Claude Desktop is not officially available on Linux. Use
  Claude Code or another client.
