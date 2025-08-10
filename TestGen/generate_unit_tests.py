from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Dict, Tuple

from lark import Lark

from openai import OpenAI  # type: ignore


DEFAULT_MODEL = os.environ.get("GEN_UNIT_TESTS_MODEL", "gpt-5-mini")
GRAMMAR_PATH_DEFAULT = Path(__file__).parent / "maestro_grammar.lark"


def load_grammar_text(grammar_path: Path) -> str:
    return grammar_path.read_text(encoding="utf-8")


def validate_with_lark(grammar_text: str, yaml_text: str) -> None:
    parser = Lark(grammar_text, start="start", parser="lalr")
    parser.parse(yaml_text)


def extract_tool_input_from_response(response) -> Optional[str]:
    out = getattr(response, "output", None)
    if not out:
        return None
    for item in out:
        if hasattr(item, "input") and isinstance(item.input, str):
            return item.input
    chunks: List[str] = []
    for item in out:
        if hasattr(item, "content"):
            for content in item.content:
                if hasattr(content, "text") and isinstance(content.text, str):
                    chunks.append(content.text)
    return "".join(chunks) if chunks else None


def _truncate(text: str, limit: int = 8000) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit // 2]
    tail = text[-limit // 2 :]
    return head + "\n... <truncated> ...\n" + tail


def build_prompt(
    user_message: str,
    changed_files: List[str],
    related_files: List[str],
    changed_diffs: Dict[str, str],
    related_file_bodies: Dict[str, str],
) -> str:
    changed_list = "\n".join(f"- {p}" for p in changed_files) if changed_files else "- (none)"
    related_list = "\n".join(f"- {p}" for p in related_files) if related_files else "- (none)"

    examples = (
        'appId: "com.example.app"\n'
        '---\n'
        '- tapOn: "Login"\n'
        '- inputText: "username"\n'
        '- inputText: "password"\n'
        '- assertVisible: "Welcome"\n'
        '\n'
        '- tapOn:\n'
        '  id: "login_button"\n'
    )
    parts: List[str] = []
    parts.append(
        "Call the maestro_yaml_grammar tool to generate ONE Maestro YAML test flow. "
        "Strictly conform to the grammar. Use DOUBLE QUOTES for all strings. "
        "Do NOT emit 'tapOn:' without an immediate indented line containing either 'id:' or 'text:'.\n"
    )
    parts.append(f"\nUser message:\n{user_message}\n")
    parts.append(f"\nChanged files (paths):\n{changed_list}\n")

    if changed_diffs:
        parts.append("\nChanged file diffs (for context only):\n")
        for p, diff in changed_diffs.items():
            parts.append(f"\n# DIFF: {p}\n" + _truncate(diff))

    parts.append(f"\nRelated files (paths):\n{related_list}\n")
    if related_file_bodies:
        parts.append("\nRelated file contents (for context only):\n")
        for p, body in related_file_bodies.items():
            parts.append(f"\n# FILE: {p}\n" + _truncate(body))

    parts.append("\nFollow these patterns exactly (indentation and quoting):\n" + examples)
    parts.append(
        "\nCRITICAL FORMATTING RULES:\n"
        "- Use double-quoted strings for ALL text and file paths.\n"
        "- Include the appId header and the '---' separator.\n"
        "- For commands with parameters, choose ONE format:\n"
        "  * Simple: 'tapOn: \"text\"' (one line)\n"
        "  * Map: 'tapOn:' NEWLINE '  id: \"...\"' (2-space indent)\n"
        "- NEVER use 'tapOn:' alone without immediate content\n"
        "- takeScreenshot requires map form: 'takeScreenshot:' NEWLINE '  name: \"...\"'\n"
        "- If using conditions, use 'when:' followed by 4-space indented lines.\n"
    )
    return "".join(parts)


# mock generation removed


def generate_one_with_gpt(
    client: OpenAI,
    model: str,
    grammar_text: str,
    user_message: str,
    changed_files: List[str],
    related_files: List[str],
    changed_diffs: Dict[str, str],
    verbosity: str,
    minimal_reasoning: bool,
) -> str:
    # Prepare context: read related file bodies
    related_bodies: Dict[str, str] = {}
    for p in related_files:
        try:
            content = Path(p).read_text(encoding="utf-8")
            related_bodies[p] = content
        except Exception:
            continue

    prompt = build_prompt(
        user_message,
        changed_files,
        related_files,
        changed_diffs=changed_diffs,
        related_file_bodies=related_bodies,
    )
    for attempt in range(2):  # Reduced retries for faster testing
        response = client.responses.create(
            model=model,
            input=prompt if attempt == 0 else (
                prompt +
                "\n\nCORRECTION: Grammar violation! For mapping commands like 'tapOn:', 'takeScreenshot:', etc:\n" +
                "- Simple form: 'tapOn: \"text\"' (one line)\n" +
                "- Map form: 'tapOn:' then NEWLINE, then '  id: \"...\"' (indented 2 spaces)\n" +
                "NEVER mix forms. After a colon in map form, ALWAYS have a newline before the indented properties."
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
                        "Generates a Maestro YAML test flow. YOU MUST ONLY EMIT STRINGS VALID UNDER THE PROVIDED LARK GRAMMAR."
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
            continue
        try:
            validate_with_lark(grammar_text, tool_input)
            return tool_input
        except Exception as e:
            # Log what was generated for debugging
            if attempt == 1:  # Last attempt
                print(json.dumps({
                    "debug": "Last attempt failed validation",
                    "generated": tool_input[:500] if tool_input else "None",
                    "error": str(e)
                }), file=sys.stderr)
            continue
    raise RuntimeError("Failed to generate valid YAML after retries")


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate Maestro unit tests as JSON using CFG via GPT-5")
    ap.add_argument("--grammar", type=Path, default=GRAMMAR_PATH_DEFAULT)
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--verbosity", choices=["low", "medium", "high"], default="low")
    ap.add_argument("--minimal-reasoning", action="store_true")
    ap.add_argument("--stdin-json", action="store_true", help="Read input JSON from stdin. Accepts either a flat schema or the 'modification context' envelope.")
    ap.add_argument("--userMessage")
    ap.add_argument("--changedFiles", nargs="*")
    ap.add_argument("--relatedFiles", nargs="*")
    args = ap.parse_args(argv)

    # Input parsing
    user_message = args.userMessage or ""
    changed_files: List[str] = args.changedFiles or []
    related_files: List[str] = args.relatedFiles or []

    extra_context_changed_diffs: Dict[str, str] = {}
    if args.stdin_json:
        try:
            payload = json.load(sys.stdin)
            # Support two shapes: flat {userMessage, changedFiles, relatedFiles} or envelope with { modification: { userMessage, modifiedFiles, relatedFiles } }
            if "modification" in payload and isinstance(payload["modification"], dict):
                mod = payload["modification"]
                user_message = mod.get("userMessage", user_message)
                changed_files = [m.get("path") for m in (mod.get("modifiedFiles") or []) if m.get("path")]
                related_files = mod.get("relatedFiles", related_files) or []
                # gather diffs for prompt
                for m in (mod.get("modifiedFiles") or []):
                    pth = m.get("path")
                    diff = m.get("diff")
                    if pth and isinstance(diff, str):
                        extra_context_changed_diffs[pth] = diff
            else:
                user_message = payload.get("userMessage", user_message)
                changed_files = payload.get("changedFiles", changed_files) or []
                related_files = payload.get("relatedFiles", related_files) or []
            if "count" in payload:
                args.count = int(payload["count"])  # type: ignore
        except Exception as e:
            print(json.dumps({"error": f"Invalid stdin JSON: {e}"}), file=sys.stderr)
            return 1

    grammar_text = load_grammar_text(args.grammar)

    tests: List[str] = []

    # Hardcoded API key (or fallback to environment)
    api_key = os.environ.get("OPENAI_API_KEY") or "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"
    
    if not api_key:
        print(json.dumps({"error": "OPENAI_API_KEY is not set"}), file=sys.stderr)
        return 1
    
    client = OpenAI(api_key=api_key)

    for i in range(args.count):
        unit = generate_one_with_gpt(
            client=client,
            model=args.model,
            grammar_text=grammar_text,
            user_message=user_message,
            changed_files=changed_files,
            related_files=related_files,
            changed_diffs=extra_context_changed_diffs,
            verbosity=args.verbosity,
            minimal_reasoning=bool(args.minimal_reasoning),
        )
        # Validate locally regardless
        validate_with_lark(grammar_text, unit)
        tests.append(unit)

    print(json.dumps({"tests": tests}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


