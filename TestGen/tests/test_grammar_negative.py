import pathlib
import pytest
from lark import Lark, UnexpectedInput

GRAMMAR_PATH = pathlib.Path(__file__).parents[1] / "maestro_grammar.lark"
GRAMMAR = GRAMMAR_PATH.read_text()
parser = Lark(GRAMMAR, start="start", parser="lalr")


def parse_fail(yaml_text: str):
    with pytest.raises(UnexpectedInput):
        parser.parse(yaml_text)


def test_missing_app_id():
    s = (
        '---\n'
        '- tapOn: "Login"\n'
    )
    parse_fail(s)


def test_missing_separator():
    s = (
        'appId: "com.example.app"\n'
        '- tapOn: "Login"\n'
    )
    parse_fail(s)


def test_invalid_direction():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- scroll:\n'
        '  direction: middle\n'
    )
    parse_fail(s)


def test_press_key_invalid_key():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- pressKey:\n'
        '  key: meta\n'
    )
    parse_fail(s)


def test_tap_map_requires_id_or_text():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- tapOn:\n'
        '  index: 0\n'
    )
    parse_fail(s)


def test_string_must_be_quoted():
    s = (
        'appId: com.example.app\n'
        '---\n'
        '- tapOn: Login\n'
    )
    parse_fail(s)
