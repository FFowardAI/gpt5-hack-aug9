from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional

from lark import Lark

try:
    # GPT-5 SDK (per cookbook)
    from openai import OpenAI
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "openai package is required. Please install with: pip install 'openai>=1.99.2'"
    ) from exc


DEFAULT_MODEL = "gpt-5-mini"
OPENAI_API_KEY = "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"


def load_grammar_text(grammar_path: Path) -> str:
    return grammar_path.read_text(encoding="utf-8")


def validate_with_lark(grammar_text: str, yaml_text: str) -> None:
    parser = Lark(grammar_text, start="start", parser="lalr")
    parser.parse(yaml_text)


def extract_tool_input_from_response(response) -> Optional[str]:
    # Cookbook shows `response.output[1].input` for tool call input
    # Robustly find the first item that has `input` attr (tool) and return it.
    out = getattr(response, "output", None)
    if not out:
        return None
    for item in out:
        if hasattr(item, "input") and isinstance(item.input, str):
            return item.input
    # Fallback: try to stitch text (not ideal for tool case)
    chunks: list[str] = []
    for item in out:
        if hasattr(item, "content"):
            for content in item.content:
                if hasattr(content, "text") and isinstance(content.text, str):
                    chunks.append(content.text)
    return "".join(chunks) if chunks else None


def build_prompt(task: str) -> str:
    examples = (
        'appId: "com.example.app"\n'
        '---\n'
        '- tapOn: "Login"\n'
        '- inputText: "username"\n'
        '- inputText: "password"\n'
        '- assertVisible: "Welcome"\n'
        '\n'
        '# Mapping form (must include id OR text, with two-space indent)\n'
        '- tapOn:\n'
        '  id: "login_button"\n'
        '\n'
        '# INVALID (do NOT do this)\n'
        '# - tapOn:\n'
        '#   # missing id/text under tapOn is invalid under the grammar\n'
    )
    return (
        "Call the maestro_yaml_grammar tool to generate a Maestro YAML test file. "
        "It must strictly conform to the grammar. Use DOUBLE QUOTES for all strings. "
        "Do NOT emit 'tapOn:' without an immediate indented line containing either 'id:' or 'text:'.\n\n"
        f"Task: {task}\n\n"
        "Follow these patterns exactly (pay attention to indentation and quoting):\n"
        f"{examples}\n"
        "Requirements:\n"
        "- Use double-quoted strings for all text and file paths.\n"
        "- Include the appId header and the '---' separator.\n"
        "- Preferred: one-line 'tapOn: \"TEXT\"' or mapping with 'id:'/'text:' (never bare 'tapOn:').\n"
        "- If using conditions, use 'when:' followed by 4-space indented lines with one of: visible, notVisible, platform, true.\n"
    )


def build_mock_yaml(task: str) -> str:
    t = task.lower()
    if "when" in t or "platform" in t or "visible" in t:
        body = (
            '- runFlow:\n'
            '  when:\n'
            '    visible: "Update Available"\n'
            '  file: "flows/update.yaml"\n'
            '- runScript:\n'
            '  when:\n'
            '    platform: iOS\n'
            '  file: "scripts/setup.js"\n'
        )
    elif "scroll" in t or "swipe" in t or "presskey" in t:
        body = (
            '- pressKey:\n'
            '  key: enter\n'
            '- scroll:\n'
            '  direction: down\n'
            '  times: 2\n'
            '- swipe:\n'
            '  direction: left\n'
            '  durationMs: 300\n'
        )
    elif "tap" in t and "map" in t:
        body = (
            '- tapOn:\n'
            '  id: "login_button"\n'
            '  index: 0\n'
            '  optional: true\n'
            '  timeoutMs: 3000\n'
        )
    elif "simple" in t or "launchapp" in t:
        body = (
            '- launchApp\n'
            '- back\n'
            '- hideKeyboard\n'
            '- waitForAnimationToEnd\n'
            '- clearState\n'
            '- clearKeychain\n'
            '- takeScreenshot\n'
        )
    else:
        body = (
            '- tapOn: "Login"\n'
            '- inputText: "username"\n'
            '- inputText: "password"\n'
            '- tapOn: "Submit"\n'
            '- assertVisible: "Welcome"\n'
        )

    header = 'appId: "com.example.app"\n---\n'
    return header + body


def run(
    *,
    model: str,
    grammar_text: str,
    output_path: Path,
    verbosity: str,
    minimal_reasoning: bool,
    task: str,
    mock: bool = False,
) -> int:
    if mock:
        mock_yaml = build_mock_yaml(task)
        validate_with_lark(grammar_text, mock_yaml)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(mock_yaml, encoding="utf-8")
        print(f"[mock] Wrote {output_path}")
        return 0

    client = OpenAI(api_key=OPENAI_API_KEY)

    prompt = build_prompt(task)

    last_error: Optional[str] = None
    for attempt in range(3):
        response = client.responses.create(
            model=model,
            input=prompt if attempt == 0 else (
                prompt +
                "\n\nCorrection: You previously violated the grammar. Ensure 'tapOn:' is either a one-line form 'tapOn: \"...\"' or includes an indented 'id:' or 'text:' line. Use double quotes everywhere."
            ),
            text={
                "verbosity": verbosity,
                "format": {"type": "text"},
            },
            tools=[
                {
                    "type": "custom",
                    "name": "maestro_yaml_grammar",
                    "description": (
                        "Generates Maestro YAML test files with header, separator, and flow commands. "
                        "YOU MUST ONLY EMIT STRINGS VALID UNDER THE PROVIDED LARK GRAMMAR."
                    ),
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": grammar_text,
                    },
                }
            ],
            parallel_tool_calls=False,
            reasoning={"effort": "minimal" if minimal_reasoning else "medium"},
        )

        tool_input = extract_tool_input_from_response(response)
        if not tool_input:
            last_error = "No tool input found in response"
            continue

        try:
            validate_with_lark(grammar_text, tool_input)
        except Exception as e:
            last_error = f"Parse error: {e}"
            continue

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(tool_input, encoding="utf-8")
        print(f"Wrote {output_path}")
        return 0

    raise SystemExit(last_error or "Failed to generate valid YAML after retries")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Generate Maestro YAML using GPT-5 constrained by a Lark CFG.")
    p.add_argument("--grammar", type=Path, default=Path(__file__).parent / "maestro_grammar.lark")
    p.add_argument("--model", default=DEFAULT_MODEL, help="Model id, e.g. gpt-5 or gpt-5-mini")
    p.add_argument("--out", type=Path, default=Path(__file__).parent / "out/gpt5_flow.yaml")
    p.add_argument(
        "--verbosity",
        choices=["low", "medium", "high"],
        default="low",
        help="Text verbosity hint (see GPT-5 cookbook)",
    )
    p.add_argument(
        "--minimal-reasoning",
        action="store_true",
        help="Use minimal reasoning effort for faster time-to-first-token",
    )
    p.add_argument(
        "--task",
        default=(
            "Create a login flow: tap on 'Login', input username and password, submit, "
            "and assert 'Welcome' is visible."
        ),
        help="High-level task for YAML generation",
    )
    p.add_argument(
        "--mock",
        action="store_true",
        help="Generate using local mock examples (no API call), still validated by CFG",
    )
    args = p.parse_args(argv)

    grammar_text = load_grammar_text(args.grammar)

    try:
        return run(
            model=args.model,
            grammar_text=grammar_text,
            output_path=args.out,
            verbosity=args.verbosity,
            minimal_reasoning=bool(args.minimal_reasoning),
            task=args.task,
            mock=bool(args.mock),
        )
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
