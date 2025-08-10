## Maestro YAML CFG (Lark)

This folder contains a Lark grammar that constrains a well‑behaved subset of Maestro YAML test files, plus pytest tests to validate positive and negative cases.

What’s covered:
- Header: `appId: "…"` and `---` separator
- Common commands: `launchApp`, `back`, `hideKeyboard`, `waitForAnimationToEnd`, `clearState`, `clearKeychain`, `takeScreenshot`
- One‑liners: `tapOn: "…"`, `inputText: "…"`, `assertVisible: "…"`, `assertNotVisible: "…"`, `openLink: "…"`
- Mapping commands with enums and bounded scalars:
  - `tapOn:` with `id|text` and optional `index|optional|timeoutMs`
  - `pressKey:` with enumerated keys
  - `eraseText:` with `characters`
  - `scroll:` with `direction` and optional `times`
  - `swipe:` with `direction` and optional `durationMs`
  - `takeScreenshot:` with `name`
  - `runFlow:` / `runScript:` with optional `when` (conditions: `visible|notVisible|platform|true`) and `file`

Assumptions:
- Strings must be quoted. Files/paths are quoted strings.
- Platforms: `iOS|Android`. Directions: `up|down|left|right`.
- Keys: a conservative cross‑platform set (`enter`, `return`, `go`, `done`, `tab`, `escape`, `space`, `backspace`, `delete`, `back`, `home`, `menu`, `search`, `volumeUp`, `volumeDown`, `camera`, arrow keys).
- Indentation is explicit and required.

### Dev

Install deps and run tests:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r maestro-cfg/requirements.txt
pytest -q maestro-cfg/tests
```

### Notes
- The grammar is intentionally strict and bounded to minimize drift.
- Extend enums or add commands as needed to mirror your Maestro version.
