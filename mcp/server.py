#!/usr/bin/env python3
"""
FastMCP server that integrates with Cursor.

Exposes a single tool `agent_finished` that, when called by a Cursor agent
at the end of its run, returns a unified diff describing what changed in the
repository (staged, unstaged, and untracked files) relative to the current
HEAD.

Usage (via Cursor MCP): configure this script as an MCP server using stdio.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import List, Optional
import difflib
from fastmcp import FastMCP
import json

try:
    import requests
except Exception:  # pragma: no cover
    requests = None  # will error at use-time with friendly message

mcp = FastMCP("fastMCP")

CONFIG_PATH = (Path(__file__).parent / "config.json").resolve()


def load_settings() -> dict:
    """Load persistent server settings from mcp/config.json."""
    try:
        if CONFIG_PATH.exists():
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"copperEnabled": False, "apiBaseUrl": "http://localhost:5055"}


def save_settings(settings: dict) -> None:
    """Persist server settings to mcp/config.json."""
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    except Exception:
        # Best-effort; swallow IO errors to avoid crashing the server
        return


def build_api_url(path: str) -> str:
    settings = load_settings()
    base = settings.get("apiBaseUrl") or "http://localhost:5055"
    if base.endswith('/'):
        base = base[:-1]
    if not path.startswith('/'):
        path = '/' + path
    return base + path

def find_git_root(start_directory: Path) -> Optional[Path]:
    """Walk upward from start_directory to find a directory containing a .git folder.

    Returns None if no git repository is found.
    """
    current: Path = start_directory.resolve()
    for parent in [current, *current.parents]:
        if (parent / ".git").exists():
            return parent
    return None


def run_git_command(repo_root: Path, args: List[str]) -> str:
    """Run a git command in the specified repository root and return stdout as text.

    Does not raise if git exits non-zero; returns empty string instead.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), *args],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return ""
        return result.stdout
    except Exception:
        return ""


def get_staged_and_unstaged_diff(repo_root: Path) -> str:
    """Return unified diff for staged and unstaged changes."""
    unstaged = run_git_command(repo_root, ["diff", "--no-ext-diff"])
    staged = run_git_command(repo_root, ["diff", "--no-ext-diff", "--cached"])
    combined = []
    if unstaged.strip():
        combined.append(unstaged)
    if staged.strip():
        combined.append(staged)
    return "\n".join(combined)


def list_untracked_files(repo_root: Path) -> List[Path]:
    """List untracked files (respecting .gitignore)."""
    stdout = run_git_command(
        repo_root,
        ["ls-files", "--others", "--exclude-standard"],
    )
    files: List[Path] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        files.append(repo_root / line)
    return files


def unified_diff_for_new_file(repo_root: Path, file_path: Path) -> str:
    """Create a unified diff that adds the given untracked file.

    This does not shell out to git; it generates a unified diff from empty
    to the file's current contents, which makes it suitable to concatenate
    with `git diff` output.
    """
    try:
        # Read file as text using UTF-8; fall back to ignoring errors to avoid binary crashes.
        content = file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        content = ""
    new_lines = content.splitlines(keepends=True)
    rel = file_path.relative_to(repo_root)

    # Produce a diff similar to git's new-file patch headers
    header = [
        f"diff --git a/{rel} b/{rel}\n",
        f"new file mode 100644\n",
        f"index 0000000..0000000\n",
    ]
    body = difflib.unified_diff(
        [],
        new_lines,
        fromfile="/dev/null",
        tofile=f"b/{rel}",
        lineterm="",
    )
    return "".join(header) + "\n".join(body) + ("\n" if new_lines else "")


def get_untracked_diffs(repo_root: Path) -> str:
    """Return unified diffs for all untracked files."""
    diffs: List[str] = []
    for path in list_untracked_files(repo_root):
        diffs.append(unified_diff_for_new_file(repo_root, path))
    return "\n".join(filter(None, diffs)).strip()


def list_changed_files(repo_root: Path) -> List[Path]:
    """List files changed relative to HEAD (staged + unstaged), repository-relative paths.

    Includes untracked files.
    """
    names_stdout = run_git_command(repo_root, ["diff", "--name-only", "HEAD"])
    changed: set[Path] = set()
    for line in names_stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        changed.add(Path(line))
    for untracked in list_untracked_files(repo_root):
        try:
            changed.add(untracked.relative_to(repo_root))
        except Exception:
            # Should not happen, but ignore if relative_to fails
            pass
    return sorted(repo_root / p for p in changed)


def per_file_diff(repo_root: Path, file_path: Path) -> str:
    """Return unified diff for a single file relative to HEAD. Handles untracked files."""
    # Determine if file is tracked by checking git ls-files --error-unmatch
    rel = file_path.relative_to(repo_root)
    tracked = run_git_command(repo_root, ["ls-files", "--error-unmatch", str(rel)]) != ""
    if not tracked:
        return unified_diff_for_new_file(repo_root, file_path)
    # Diff against HEAD to include both staged and unstaged changes
    return run_git_command(repo_root, ["diff", "--no-ext-diff", "HEAD", "--", str(rel)])


@mcp.tool(
    name="toggle_copper",
    description=(
        "Enable or disable Copper integration. When enabled, Copper-related actions should run"
        " automatically after the agent finishes. Accepts a boolean 'enabled' argument."
    ),
)
def toggle_copper(enabled: bool) -> str:
    settings = load_settings()
    settings["copperEnabled"] = bool(enabled)
    save_settings(settings)
    return f"Copper enabled: {settings['copperEnabled']}"


@mcp.tool(name="get_settings", description="Return server settings including 'copperEnabled'.")
def get_settings() -> str:
    import json

    return json.dumps(load_settings())


@mcp.tool(
    name="test_modification",
    description=(
        "Accepts context for test generation after an agent completes a change: the original user message,"
        " a list of modified files with their diffs, and a list of related files. Should be called ALWAYS after the agent finishes its work"
    ),
)
def test_modification(
    user_message: str,
    modified_files: list[dict],
    related_files: list[str],
) -> str:
    """Receive modification context for downstream test generation.

    Args:
        user_message: The original user request that initiated the change.
        modified_files: A list of objects describing modified files. Each object should include:
            - path: Repository-relative file path.
            - diff: Unified diff representing the modifications to that file.
        related_files: Repository-relative paths to files directly influenced by this change or
            otherwise useful for generating tests.

    Returns:
        A short acknowledgment summary suitable for logging/inspection.
    """
    if not isinstance(user_message, str):
        return "Invalid input: 'user_message' must be a string."

    # Normalize and lightly validate shapes; do not enforce strict schema to remain flexible.
    normalized_modified: list[dict] = []
    for entry in modified_files or []:
        if not isinstance(entry, dict):
            continue
        # Accept multiple key names from different callers
        path_val = (
            entry.get("path")
            or entry.get("target_file")
            or entry.get("file")
            or entry.get("filepath")
        )
        diff_val = entry.get("diff") or entry.get("patch") or entry.get("delta")
        if isinstance(path_val, str):
            # Ensure forward slashes in JSON
            path_str = path_val.replace("\\", "/")
            # Allow empty diff strings (some callers may omit real unified diffs)
            if isinstance(diff_val, str):
                normalized_modified.append({"path": path_str, "diff": diff_val})
            else:
                normalized_modified.append({"path": path_str, "diff": ""})

    normalized_related: list[str] = [p for p in (related_files or []) if isinstance(p, str)]

    # If caller did not pass modified files, auto-detect from git
    if not normalized_modified:
        repo_root = find_git_root(Path.cwd())
        if repo_root is not None:
            auto_files: List[dict] = []
            for abs_path in list_changed_files(repo_root):
                try:
                    rel = abs_path.relative_to(repo_root)
                except Exception:
                    rel = abs_path
                diff_text = per_file_diff(repo_root, abs_path)
                auto_files.append({"path": str(rel).replace("\\", "/"), "diff": diff_text or ""})
            normalized_modified = auto_files

    # Convert paths to absolute (prepend project/repo root) for backend consumption
    repo_root_for_abs = find_git_root(Path.cwd()) or Path.cwd()
    normalized_modified_abs: list[dict] = []
    for entry in normalized_modified:
        path_str = entry.get("path", "")
        try:
            p = Path(path_str)
            abs_p = p if p.is_absolute() else (repo_root_for_abs / p)
            abs_norm = abs_p.resolve()
            normalized_modified_abs.append({"path": str(abs_norm), "diff": entry.get("diff", "")})
        except Exception:
            # Fallback to original path if resolution fails
            normalized_modified_abs.append({"path": path_str, "diff": entry.get("diff", "")})

    normalized_related_abs: list[str] = []
    for rf in normalized_related:
        try:
            rp = Path(rf)
            abs_rp = rp if rp.is_absolute() else (repo_root_for_abs / rp)
            normalized_related_abs.append(str(abs_rp.resolve()))
        except Exception:
            normalized_related_abs.append(rf)

    # Build payload for the web server's /api/generate endpoint
    payload = {
        "userMessage": user_message,
        "modifiedFiles": normalized_modified_abs,
        "relatedFiles": normalized_related_abs,
    }

    if requests is None:
        return (
            "HTTP client not available. Install 'requests' in the MCP environment or run: "
            "pip install -r mcp/requirements.txt"
        )

    url = build_api_url("/api/generate")
    try:
        resp = requests.post(url, json=payload, timeout=20)
        status = resp.status_code
        try:
            data = resp.json()
        except Exception:
            data = {"text": resp.text[:1000]}
        ack = {
            "ok": status < 400,
            "status": status,
            "response": data,
        }
        return json.dumps(ack)
    except Exception as exc:
        err = {"ok": False, "error": str(exc), "url": url}
        return json.dumps(err)


if __name__ == "__main__":
    # Run using stdio transport for MCP over process stdio.
    mcp.run(transport="stdio")


