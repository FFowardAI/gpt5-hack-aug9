from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lark import Lark


def load_parser(grammar_path: Path) -> Lark:
    grammar_text = grammar_path.read_text(encoding="utf-8")
    return Lark(grammar_text, start="start", parser="lalr")


def parse_or_raise(parser: Lark, yaml_text: str) -> None:
    parser.parse(yaml_text)


def write_text_file(target_path: Path, content: str) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(content, encoding="utf-8")


def with_header(body: str, app_id: str = "com.example.app") -> str:
    header = f'appId: "{app_id}"\n---\n'
    if not body.endswith("\n"):
        body = body + "\n"
    return header + body


def flow_basic_one_liners() -> str:
    return """
- tapOn: "Login"
- assertVisible: "Welcome"
""".strip() + "\n"


def flow_tap_mapping_with_extras() -> str:
    return """
- tapOn:
  id: "login_button"
  index: 0
  optional: true
  timeoutMs: 5000
""".strip() + "\n"


def flow_press_scroll_swipe() -> str:
    return """
- pressKey:
  key: enter
- scroll:
  direction: down
  times: 2
- swipe:
  direction: left
  durationMs: 300
""".strip() + "\n"


def flow_conditions() -> str:
    return """
- runFlow:
  when:
    visible: "Update Available"
  file: "flows/update.yaml"
- runScript:
  when:
    platform: iOS
  file: "scripts/setup.js"
""".strip() + "\n"


def flow_simple_commands() -> str:
    return """
- launchApp
- back
- hideKeyboard
- waitForAnimationToEnd
- clearState
- clearKeychain
- takeScreenshot
""".strip() + "\n"


def flow_take_screenshot_named() -> str:
    return """
- takeScreenshot:
  name: "after_login"
""".strip() + "\n"


def build_examples() -> dict[str, str]:
    return {
        "flow_basic.yaml": with_header(flow_basic_one_liners()),
        "flow_tap_mapping.yaml": with_header(flow_tap_mapping_with_extras()),
        "flow_keys_scroll_swipe.yaml": with_header(flow_press_scroll_swipe()),
        "flow_conditions.yaml": with_header(flow_conditions()),
        "flow_simple.yaml": with_header(flow_simple_commands()),
        "flow_screenshot.yaml": with_header(flow_take_screenshot_named()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate Maestro YAML files that comply with the CFG.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).parent / "out",
        help="Directory to write generated YAML files",
    )
    parser.add_argument(
        "--grammar",
        type=Path,
        default=Path(__file__).parent / "maestro_grammar.lark",
        help="Path to the Lark grammar file",
    )
    args = parser.parse_args(argv)

    lark_parser = load_parser(args.grammar)
    examples = build_examples()

    written: list[Path] = []
    for filename, content in examples.items():
        # Validate against CFG before writing
        parse_or_raise(lark_parser, content)
        target = args.output_dir / filename
        write_text_file(target, content)
        written.append(target)

    for p in written:
        print(f"Wrote {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


