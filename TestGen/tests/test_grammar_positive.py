import pathlib
from lark import Lark

GRAMMAR_PATH = pathlib.Path(__file__).parents[1] / "maestro_grammar.lark"
GRAMMAR = GRAMMAR_PATH.read_text()
parser = Lark(GRAMMAR, start="start", parser="lalr")


def parse_ok(yaml_text: str):
    parser.parse(yaml_text)


def test_minimal_tap_and_assert():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- tapOn: "Login"\n'
        '- assertVisible: "Welcome"\n'
    )
    parse_ok(s)


def test_mapping_tap_by_id_with_extras():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- tapOn:\n'
        '  id: "login_button"\n'
        '  index: 0\n'
        '  optional: true\n'
        '  timeoutMs: 5000\n'
    )
    parse_ok(s)


def test_press_key_and_scroll_swipe():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- pressKey:\n'
        '  key: enter\n'
        '- scroll:\n'
        '  direction: down\n'
        '  times: 2\n'
        '- swipe:\n'
        '  direction: left\n'
        '  durationMs: 300\n'
    )
    parse_ok(s)


def test_run_flow_and_script_with_when():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- runFlow:\n'
        '  when:\n'
        '    visible: "Update Available"\n'
        '  file: "flows/update.yaml"\n'
        '- runScript:\n'
        '  when:\n'
        '    platform: iOS\n'
        '  file: "scripts/setup.js"\n'
    )
    parse_ok(s)


def test_simple_commands_inline():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- back\n'
        '- hideKeyboard\n'
        '- waitForAnimationToEnd\n'
        '- clearState\n'
        '- clearKeychain\n'
        '- takeScreenshot\n'
    )
    parse_ok(s)


def test_take_screenshot_named():
    s = (
        'appId: "com.example.app"\n'
        '---\n'
        '- launchApp\n'
        '- takeScreenshot:\n'
        '  name: "after_login"\n'
    )
    parse_ok(s)
