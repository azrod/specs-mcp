# specs-mcp

An MCP server (stdio) that exposes `spec_*` tools to create, read, search, validate, and list Markdown specifications in a project.

## Installation

Requires Node.js >= 22.

```sh
npx -y @azrod/specs-mcp
```

No global installation is needed. Your MCP client starts the server with this command and communicates over stdio; configure it below rather than running a separate server. To build locally instead, see [From source](#from-source).

## Client configuration

Choose your client and merge the example into its configuration file. Node.js and `npx` must be available to the client (including GUI applications).

The server uses the first project root supplied by the client, or its working directory if none is supplied. For clients without a usable root, set an explicit project path as shown in [Passing options](#passing-options). With multiple workspace folders, use an explicit root to select one.

<details><summary><b>Claude Code</b></summary>

Run this in your project to add a shared, project-scoped server to `.mcp.json`:

```sh
claude mcp add --scope project specs -- npx -y @azrod/specs-mcp
```

Or edit `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

Use `--scope user` instead for all projects. Launch Claude Code from the intended project directory.

[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

</details>

<details><summary><b>Claude Desktop</b></summary>

Edit the global `claude_desktop_config.json` file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

Claude Desktop does not provide a usable project root: add `--root` (or `SPECS_ROOT`) using [Passing options](#passing-options), otherwise the server uses its current working directory. Restart Claude Desktop after editing the file.

[Claude Desktop local-server setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

</details>

<details><summary><b>opencode</b></summary>

For OpenCode V2, edit `opencode.json` at the project root, or `~/.config/opencode/opencode.json` for global configuration:

```json
{
  "mcp": {
    "servers": {
      "specs": {
        "type": "local",
        "command": ["npx", "-y", "@azrod/specs-mcp"]
      }
    }
  }
}
```

Or add it from the CLI (put `--global` before `--` for global configuration):

```sh
opencode mcp add specs -- npx -y @azrod/specs-mcp
```

The local server's working directory defaults to the workspace. OpenCode uses `environment` rather than `env` for server environment variables.

[OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers).

</details>

<details><summary><b>Codex</b></summary>

Add the server from the CLI:

```sh
codex mcp add specs -- npx -y @azrod/specs-mcp
```

Or edit the global `~/.codex/config.toml` (also shared with the IDE extension), or `.codex/config.toml` for a trusted project:

```toml
[mcp_servers.specs]
command = "npx"
args = ["-y", "@azrod/specs-mcp"]
```

Start Codex in the intended project. Use an explicit root if the server's working directory differs from that project.

[Codex MCP documentation](https://developers.openai.com/codex/mcp/).

</details>

<details><summary><b>Cursor</b></summary>

Edit `.cursor/mcp.json` at the project root, or `~/.cursor/mcp.json` for global configuration:

```json
{
  "mcpServers": {
    "specs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

Open the intended project folder in Cursor.

[Cursor MCP documentation](https://cursor.com/docs/context/mcp).

</details>

<details><summary><b>VS Code (GitHub Copilot)</b></summary>

For an editor-managed server, edit `.vscode/mcp.json` in your workspace. For global configuration, run **MCP: Open User Configuration** to open your profile's `mcp.json`:

```json
{
  "servers": {
    "specs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

The working directory defaults to the workspace folder. Alternatively, add the server to your user profile from a Bash-compatible shell:

```sh
code --add-mcp '{"name":"specs","type":"stdio","command":"npx","args":["-y","@azrod/specs-mcp"]}'
```

Current Copilot sessions can receive eligible editor-managed definitions through forwarding. For native Copilot configuration instead, use `.mcp.json` at the workspace root or `~/.copilot/mcp-config.json` globally, with the same server entry under `mcpServers` rather than `servers` (and `"tools": ["*"]` to expose all tools). The editor-managed format belongs to the deprecated Local harness; check the destination when using **MCP: Add Server**.

[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

</details>

<details><summary><b>Windsurf</b></summary>

Open Cascade's MCP menu and choose **Open MCP config file** to edit the global `mcp_config.json` used by your installation:

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

Legacy stable builds use `~/.codeium/windsurf/mcp_config.json`. Current documentation distinguishes that editor-discovery file from Cascade's Cortex-managed file: `~/.config/devin/mcp_config.json` on macOS/Linux (or `$XDG_CONFIG_HOME/devin/mcp_config.json`), and `%AppData%/devin/mcp_config.json` on Windows. Use the file opened by your installation; enable the `windsurf` discovery source if reusing the legacy file.

Refresh MCP servers after saving. Set an explicit root if the client does not supply the intended project folder.

[Windsurf Cascade MCP configuration](https://docs.windsurf.com/plugins/cascade/mcp).

</details>

<details><summary><b>Gemini CLI</b></summary>

Edit `.gemini/settings.json` in your project, or `~/.gemini/settings.json` for global configuration:

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

Or add it to the project from the CLI:

```sh
gemini mcp add --scope project specs npx -- -y @azrod/specs-mcp
```

Use `--scope user` for global configuration. Start Gemini CLI in the intended project directory.

[Gemini CLI MCP documentation](https://geminicli.com/docs/tools/mcp-server/).

</details>

<details><summary><b>pi</b></summary>

To connect through the [pi-mcp-adapter extension](https://github.com/nicobailon/pi-mcp-adapter), install it and restart pi:

```sh
pi install npm:pi-mcp-adapter
```

Edit `.mcp.json` at the project root, or `~/.config/mcp/mcp.json` for global configuration:

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"]
    }
  }
}
```

The adapter also provides `/mcp-adapter setup` for guided configuration. Start pi in the intended project. On pi versions with built-in MCP, the adapter replaces that integration rather than running alongside it.

[pi-mcp-adapter installation and configuration](https://github.com/nicobailon/pi-mcp-adapter#readme).

</details>

### Passing options

Append server options after the package name:

```sh
npx -y @azrod/specs-mcp --root /path/to/project --specs-dir specifications
```

For clients with `command` / `args` / `env` configuration, the equivalent server entry is:

```json
{
  "mcpServers": {
    "specs": {
      "command": "npx",
      "args": ["-y", "@azrod/specs-mcp"],
      "env": {
        "SPECS_ROOT": "/path/to/project",
        "SPECS_DIR": "specifications"
      }
    }
  }
}
```

Adapt the enclosing key to your client (`servers` in VS Code; `mcp.servers` in OpenCode V2). OpenCode takes a command array and uses `environment`; Codex uses TOML. Use an absolute project path for GUI clients.

## Options

| Option | Environment variable | Default | Description |
|--------|--------------------------|--------|------|
| `--root <dir>` | `SPECS_ROOT` | none | Project root. |
| `--specs-dir <dir>` | `SPECS_DIR` | `docs/specs` | Specifications directory, relative to the root. An empty value is an error (`paths.specs must be a non-empty string`). |

Command-line options take precedence over environment variables.

Without `--root` or `SPECS_ROOT`, the root is the first `file://` root provided by the MCP client (`roots/list`), falling back to `process.cwd()`. It is resolved on the first tool call.

## Tools

Nine tools are available. All arguments are strings; arguments marked with `?` are optional.

| Tool | Arguments | Description |
|------|-----------|------|
| `spec_get` | `id`, `cursor`? | Reads a bounded page (16,384 bytes) of a specification, with `file` and `frontmatter` for the whole document. Continue with `pagination.next_cursor` while `pagination.has_more` is true. |
| `spec_search` | `query`, `id`?, `type`?, `status`? | Searches for up to five passages (letter/number tokens, OR matching) with file/line citations and `source_hash`. |
| `spec_read_section` | `id`, `section_id`, `source_hash`, `cursor`? | Expands a section cited by `spec_search`, in pages; returns `STALE_SOURCE` / `STALE_CURSOR` if the specification has changed. |
| `spec_create` | `title`, `type`?, `content`? | Creates a specification (`type` defaults to `technical`, status is `draft`). Refuses to overwrite an existing file. |
| `spec_update` | `id`, `old_string`, `new_string` | Replaces a single, unique occurrence. |
| `spec_validate` | `id` | Structural validation. `valid` / `issues` report blocking errors; `warnings` reports format deviations (unknown type/status, missing or out-of-order required sections). |
| `spec_list` | `type`?, `status`? | Lists specifications with their metadata; filters use exact, case-insensitive matching. |
| `spec_delete` | `id` | Deletes a specification. |
| `spec_format` | none | Returns the canonical specification format as plain text. |

Responses: the text contains JSON (except for `spec_format`, which returns plain text), and the same object is included in `structuredContent`, described by an `outputSchema`. A failure returns `{ "error": "…" }` (with `code` for pagination and search) and `isError: true`.

## Resources

Template `spec://{id}`: `id` is the filename without `.md` (case-insensitive). The list (`resources/list`) contains one entry per specification in the directory (`name` = id, `title` = frontmatter title, `mimeType` = `text/markdown`). Reading a resource returns the full file, without pagination. An unknown specification returns MCP error `-32002`. The server sends a `resources/list_changed` notification after a successful `spec_create` or `spec_delete`.

## Prompts

| Prompt | Arguments | Content |
|--------|-----------|---------|
| `spec_format` | none | The canonical specification format. |
| `write_spec` | `title`, `type`? | Includes the format and asks the client to write the specification, then call `spec_create` and `spec_validate`. |

## Development

```sh
npm run build   # tsc -> dist/
npm test        # node --test via tsx
npm run lint    # tsc --noEmit (src + tests)
npm run test:parity   # parity checks (ORIGIN_DIR), skipped if required files are unavailable
```

## From source

In a local checkout:

```sh
npm install
npm run build
```

Replace the `npx` command in your client configuration with `node /path/to/specs-mcp/dist/index.js` (for split fields: `"command": "node"`, `"args": ["/path/to/specs-mcp/dist/index.js"]`). The installed executable is named `specs-mcp`.
