Copper settings and command palette
----------------------------------

This MCP server persists a simple setting in `mcp/config.json`:

- `copperEnabled`: boolean

Tools exposed for toggling and inspecting:

- `fastMCP.toggle_copper(enabled: bool)` — sets the flag
- `fastMCP.get_settings()` — reads current settings

You can bind these to Cursor’s Command Palette by creating custom commands that call MCP tools. For example, you can create commands named:

- "Copper: Enable" → call `toggle_copper` with `enabled: true`
- "Copper: Disable" → call `toggle_copper` with `enabled: false`
- "Copper: Toggle" → read `get_settings` then call `toggle_copper` with the inverse

When `copperEnabled` is true, your agent should call `test_modification` after finishing its edits to provide context for test generation.

