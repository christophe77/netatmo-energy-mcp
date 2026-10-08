# Compatible AI assistants and MCP clients

`netatmo-energy-mcp` is a standard **local (stdio) MCP server**. It works
with **any AI assistant or MCP client that can start a local MCP
server**, whatever model that client uses:

- Claude
- GPT / OpenAI
- Gemini
- Mistral
- local open models such as Llama, Qwen or DeepSeek, through LM Studio,
  Ollama-based clients and others

Run `npx -y netatmo-energy-mcp login` once first. After that, no client
configuration needs secrets.

Formats below were checked against each client's official documentation
on 2026-10-08. Clients evolve; if something no longer matches, please
open an issue.

## Compatibility

| Client                                                                       | Models you can use                                   | Setup                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| [Claude Desktop](#claude-desktop)                                            | Claude                                               | JSON (`mcpServers`)                   |
| [Claude Code](#claude-code)                                                  | Claude                                               | `claude mcp add`                      |
| [Cursor](#cursor)                                                            | Claude, GPT, Gemini, …                               | JSON (`mcpServers`)                   |
| [VS Code + GitHub Copilot](#vs-code--github-copilot-agent-mode) (agent mode) | GPT, Claude, Gemini, …                               | `.vscode/mcp.json` (`servers`)        |
| [GitHub Copilot CLI](#github-copilot-cli)                                    | Copilot models                                       | `copilot mcp add`                     |
| [OpenAI Codex CLI](#openai-codex-cli)                                        | OpenAI GPT models                                    | `codex mcp add` / `config.toml`       |
| [Gemini CLI](#gemini-cli)                                                    | Google Gemini                                        | `settings.json` (`mcpServers`)        |
| [Windsurf / Devin Desktop](#windsurf--devin-desktop)                         | multiple                                             | `mcp_config.json`                     |
| [Zed](#zed)                                                                  | multiple, incl. local                                | `context_servers`                     |
| [Cline](#cline-roo-code-kilo-code)                                           | multiple, incl. Ollama / LM Studio                   | `cline_mcp_settings.json`             |
| [Roo Code](#cline-roo-code-kilo-code)                                        | multiple, incl. local                                | `mcp_settings.json` / `.roo/mcp.json` |
| [Kilo Code](#cline-roo-code-kilo-code)                                       | multiple, incl. local                                | `kilo.jsonc`                          |
| [Continue](#continue) (agent mode)                                           | multiple, incl. Ollama                               | `config.yaml`                         |
| [JetBrains AI Assistant](#jetbrains-ai-assistant)                            | JetBrains AI models                                  | Settings → MCP                        |
| [Kiro](#kiro)                                                                | Kiro models                                          | `.kiro/settings/mcp.json`             |
| [Warp](#warp)                                                                | multiple                                             | MCP servers page / `.mcp.json`        |
| [LM Studio](#lm-studio) (≥ 0.3.17)                                           | **local models** (Llama, Qwen, Mistral, DeepSeek, …) | `~/.lmstudio/mcp.json`                |
| [Goose](#goose)                                                              | many providers, incl. **Ollama**                     | `goose configure` / `config.yaml`     |
| [LibreChat](#librechat) (self-hosted)                                        | any endpoint, incl. Ollama                           | `librechat.yaml`                      |
| [AnythingLLM](#anythingllm)                                                  | any, incl. Ollama / local                            | `anythingllm_mcp_servers.json`        |
| [Msty Studio](#msty-studio)                                                  | local and cloud                                      | Toolbox → STDIO                       |
| [Open WebUI](#open-webui-via-mcpo)                                           | Ollama / any                                         | via the `mcpo` proxy                  |

**Tool calling with local models.** Results depend on the model.
Small local models may call tools less reliably than large hosted ones.
Prefer models trained for tool use.

### Not compatible (remote MCP only)

These assistants only connect to **remote** MCP servers (a public HTTPS
URL), so they cannot start this local server:

- ChatGPT (apps / connectors / developer mode)
- Claude.ai on the web
- Mistral Le Chat

The server is local by design: it reads your heating data with your
credentials on your machine ([ADR-0002](../docs/adr/0002-read-only-stdio-only.md)).

---

## The common `mcpServers` format

Most clients (Claude Desktop, Cursor, Windsurf / Devin Desktop, Cline,
Roo Code, Kiro, LM Studio, JetBrains, AnythingLLM, Warp, Gemini CLI)
accept this shape:

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

**Windows.** If a client cannot start `npx` (documented for Roo Code and
Kilo Code), use `"command": "cmd", "args": ["/c", "npx", "-y", "netatmo-energy-mcp"]`.

---

## Claude Desktop

See [claude-desktop/](claude-desktop/README.md). Use the common format in
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Claude Code

See [claude-code/](claude-code/README.md).

```bash
claude mcp add --transport stdio --scope user netatmo-energy -- npx -y netatmo-energy-mcp
```

## Cursor

See [cursor/](cursor/README.md). Edit `~/.cursor/mcp.json` or
`.cursor/mcp.json`, using the common format plus `"type": "stdio"`.

## VS Code + GitHub Copilot (agent mode)

`.vscode/mcp.json` in a workspace, or **MCP: Open User Configuration**
for all workspaces. Note the top-level key is `servers`:

```json
{
  "servers": {
    "netatmo-energy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "netatmo-energy-mcp"]
    }
  }
}
```

Or from a terminal:

```bash
code --add-mcp "{\"name\":\"netatmo-energy\",\"command\":\"npx\",\"args\":[\"-y\",\"netatmo-energy-mcp\"]}"
```

See the [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

## GitHub Copilot CLI

```bash
copilot mcp add netatmo-energy -- npx -y netatmo-energy-mcp
```

The configuration lives in `~/.copilot/mcp-config.json`. See the
[Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

## OpenAI Codex CLI

```bash
codex mcp add netatmo-energy -- npx -y netatmo-energy-mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.netatmo-energy]
command = "npx"
args = ["-y", "netatmo-energy-mcp"]
```

See the [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Gemini CLI

Add the common `mcpServers` block to `~/.gemini/settings.json` (all
projects) or `.gemini/settings.json` (one project):

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

See the [Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/).

## Windsurf / Devin Desktop

Windsurf was renamed Devin Desktop in June 2026. Use the common format in
`mcp_config.json`:

- macOS/Linux: `~/.config/devin/mcp_config.json`
- Windows: `%APPDATA%\devin\mcp_config.json`

See the [Cascade MCP docs](https://docs.devin.ai/desktop/cascade/mcp).

## Zed

In Zed's settings file, or **Settings → AI → MCP Servers**:

```json
"context_servers": {
  "netatmo-energy": { "command": "npx", "args": ["-y", "netatmo-energy-mcp"], "env": {} }
}
```

See the [Zed MCP docs](https://zed.dev/docs/ai/mcp).

## Cline, Roo Code, Kilo Code

- **Cline:** MCP Servers icon → _Configure_. Use the common format.
  See the [Cline docs](https://docs.cline.bot/mcp/configuring-mcp-servers).
- **Roo Code:** global `mcp_settings.json` or project `.roo/mcp.json`.
  Use the common format; on Windows, use the `cmd /c` form. See the
  [Roo Code docs](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo).
- **Kilo Code:** `~/.config/kilo/kilo.jsonc` or project `kilo.jsonc`:

  ```jsonc
  {
    "mcp": {
      "netatmo-energy": {
        "type": "local",
        "command": ["npx", "-y", "netatmo-energy-mcp"],
        "enabled": true,
      },
    },
  }
  ```

  See the [Kilo Code docs](https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code).

## Continue

Agent mode only. In `config.yaml`, or a file in `.continue/mcpServers/`:

```yaml
mcpServers:
  - name: netatmo-energy
    type: stdio
    command: npx
    args: ['-y', 'netatmo-energy-mcp']
```

See the [Continue MCP docs](https://docs.continue.dev/customize/deep-dives/mcp).

## JetBrains AI Assistant

**Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add →
STDIO**, then paste the common format. See the
[JetBrains docs](https://www.jetbrains.com/help/ai-assistant/mcp.html).

## Kiro

Use the common format in `~/.kiro/settings/mcp.json` (user) or
`.kiro/settings/mcp.json` (workspace). See the
[Kiro docs](https://kiro.dev/docs/mcp/configuration/).

## Warp

Go to **MCP servers → + Add → CLI** and paste the common format. Warp also
reads `~/.warp/.mcp.json` and existing Claude, Codex and `.mcp.json`
configurations. See the
[Warp docs](https://docs.warp.dev/features/warp-ai/mcp).

## LM Studio

LM Studio 0.3.17 or later can use MCP tools with **local models**. Add the
common format to `mcp.json`:

- macOS/Linux: `~/.lmstudio/mcp.json`
- Windows: `%USERPROFILE%\.lmstudio\mcp.json`

`npx` must be on your `PATH`. See the
[LM Studio MCP docs](https://lmstudio.ai/docs/app/mcp).

## Goose

Run `goose configure` → _Add Extension_ → _Command-line Extension_, with
command `npx -y netatmo-energy-mcp`. Or edit `config.yaml`:

```yaml
extensions:
  netatmo-energy:
    type: stdio
    name: netatmo-energy
    enabled: true
    cmd: npx
    args: ['-y', 'netatmo-energy-mcp']
    envs: {}
    timeout: 300
```

Goose works with many providers, including local models through Ollama.
See the [Goose docs](https://goose-docs.ai/docs/guides/config-files).

## LibreChat

In `librechat.yaml` (self-hosted):

```yaml
mcpServers:
  netatmo-energy:
    type: stdio
    command: npx
    args: ['-y', 'netatmo-energy-mcp']
```

See the [LibreChat docs](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers).

## AnythingLLM

Add the common format to `<storage>/plugins/anythingllm_mcp_servers.json`.
See the [AnythingLLM docs](https://docs.anythingllm.com/mcp-compatibility/overview).

## Msty Studio

Go to **Toolbox → Add New Tool → STDIO / JSON**:
`{"command":"npx","args":["-y","netatmo-energy-mcp"]}`.
See the [Msty docs](https://docs.msty.ai/studio/toolbox/tools).

## Open WebUI (via mcpo)

Open WebUI connects to MCP over HTTP only. Expose this stdio server
locally with the `mcpo` proxy:

```bash
uvx mcpo --port 8000 -- npx -y netatmo-energy-mcp
```

Then add `http://localhost:8000` as a tool server. Keep the proxy on
`localhost`: never expose it to a network, because it serves your
heating data with your credentials. See the
[Open WebUI MCP docs](https://docs.openwebui.com/features/mcp).

## Ollama

Ollama runs models but is not an MCP client itself. Use Ollama models
from an MCP client that supports them, such as Goose, Continue, Cline,
Roo Code, Kilo Code, Zed, AnythingLLM, LibreChat, Msty or Open WebUI.

---

## Running from a local build

To run a clone instead of the npm package:

```json
{ "command": "node", "args": ["/absolute/path/to/netatmo-energy-mcp/dist/index.js"] }
```

On Windows, escape backslashes in JSON:
`"C:\\Users\\you\\netatmo-energy-mcp\\dist\\index.js"`.

## Environment variables (optional)

Clients can pass environment variables in an `env` object.

| Variable                                      | Purpose                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `NETATMO_MCP_LOG_LEVEL`                       | `debug`, `info` (default), `warn`, `error`, `silent`. Logs go to stderr (the client's MCP log), never to the protocol stream. |
| `NETATMO_MCP_CONFIG_DIR`                      | Use a different configuration folder                                                                                          |
| `NETATMO_CLIENT_ID` / `NETATMO_CLIENT_SECRET` | Override the stored app credentials. Not needed after `login`.                                                                |

See [docs/configuration.md](../docs/configuration.md).
