# specs-mcp

An MCP server (stdio) that exposes `spec_*` tools to create, read, search, validate, and list Markdown specifications in a project.

## Installation

Requires Node.js >= 22.

```sh
npm install
npm run build
```

The executable is `dist/index.js` (`specs-mcp` once the package is installed).

## Client configuration

### opencode

In `opencode.json`:

```json
{
  "mcp": {
    "specs": {
      "type": "local",
      "command": ["node", "/path/to/specs-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

With options: `"command": ["node", "/path/to/specs-mcp/dist/index.js", "--specs-dir", "docs/specs"]`.

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "specs": {
      "command": "node",
      "args": ["/path/to/specs-mcp/dist/index.js", "--root", "/path/to/project"]
    }
  }
}
```

Claude Desktop does not provide a usable root: pass `--root` (or `SPECS_ROOT`), otherwise the server uses its current working directory.

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
