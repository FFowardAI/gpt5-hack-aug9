#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def settings_path() -> Path:
    return (Path(__file__).parent / "config.json").resolve()


def load_settings() -> dict:
    path = settings_path()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"copperEnabled": False}


def save_settings(data: dict) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Toggle Copper setting for the MCP server.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--enable", action="store_true", help="Enable Copper")
    group.add_argument("--disable", action="store_true", help="Disable Copper")
    group.add_argument("--toggle", action="store_true", help="Toggle Copper on/off")
    args = parser.parse_args()

    settings = load_settings()
    current = bool(settings.get("copperEnabled", False))

    if args.enable:
        new_value = True
    elif args.disable:
        new_value = False
    else:  # toggle
        new_value = not current

    settings["copperEnabled"] = new_value
    save_settings(settings)
    print(f"Copper enabled: {new_value}")


if __name__ == "__main__":
    main()


