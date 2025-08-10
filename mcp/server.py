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
import sys
import subprocess
from pathlib import Path
from typing import List, Optional
import difflib
from fastmcp import FastMCP
import json
import requests

mcp = FastMCP("fastMCP")

CONFIG_PATH = (Path(__file__).parent / "config.json").resolve()

# HTTP timeout (seconds) for requests to the local AI tester API
# Can be overridden with environment variable MCP_API_TIMEOUT_SECONDS
API_TIMEOUT_SECONDS = int(os.getenv("MCP_API_TIMEOUT_SECONDS", "600"))


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
        "Submit modification context to start async test generation/execution. Returns a job id immediately."
    ),
)
def test_modification(
    user_message: str,
    modified_files: list[dict],
    related_files: list[str],
) -> str:
    """Start asynchronous test generation and execution on the local server.

    Returns a JSON string with { ok, status, jobId }.
    """
    if not isinstance(user_message, str):
        return json.dumps({"ok": False, "error": "user_message must be a string"})

    # Normalize inputs
    normalized_modified: list[dict] = []
    for entry in modified_files or []:
        if not isinstance(entry, dict):
            continue
        path_val = entry.get("path") or entry.get("target_file") or entry.get("file") or entry.get("filepath")
        diff_val = entry.get("diff") or entry.get("patch") or entry.get("delta") or ""
        if isinstance(path_val, str):
            normalized_modified.append({"path": path_val.replace("\\", "/"), "diff": diff_val})

    normalized_related: list[str] = [p for p in (related_files or []) if isinstance(p, str)]

    # Convert to absolute paths for server consumption
    repo_root = find_git_root(Path.cwd()) or Path.cwd()
    abs_modified: list[dict] = []
    for e in normalized_modified:
        p = Path(e["path"])  # already normalized
        abs_p = p if p.is_absolute() else (repo_root / p)
        abs_modified.append({"path": str(abs_p.resolve()), "diff": e.get("diff", "")})
    abs_related: list[str] = []
    for rf in normalized_related:
        rp = Path(rf)
        abs_related.append(str((rp if rp.is_absolute() else (repo_root / rp)).resolve()))

    payload = {
        "userMessage": user_message,
        "modifiedFiles": abs_modified,
        "relatedFiles": abs_related,
        "async": True,
    }

    url = build_api_url("/api/generate-tests?async=1")
    try:
        # Short timeout so the tool returns under Cursor's 20s cap
        resp = requests.post(url, json=payload, timeout=min(API_TIMEOUT_SECONDS, 10))
        data = {}
        try:
            data = resp.json()
        except Exception:
            data = {"text": resp.text[:500]}
        return json.dumps({
            "ok": resp.status_code < 400,
            "status": resp.status_code,
            "jobId": data.get("jobId"),
            "server": data,
        })
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"failed to start job: {exc}"})


@mcp.tool(
    name="get_job_status",
    description="Poll job status from the local server. Returns {id, status, result?, error?, progress?}."
)
def get_job_status(job_id: str) -> str:
    url = build_api_url(f"/api/job/{job_id}")
    try:
        resp = requests.get(url, timeout=min(API_TIMEOUT_SECONDS, 8))
        try:
            data = resp.json()
        except Exception:
            data = {"text": resp.text[:500]}
        return json.dumps({
            "ok": resp.status_code < 400,
            "status": resp.status_code,
            "job": data,
        })
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"failed to get status: {exc}"})


@mcp.tool(
    name="wait_job_step",
    description=(
        "Poll a job for up to step_seconds (<= 8s) to stay under tool time limits. "
        "Returns the latest status. Call repeatedly until status is 'generated'/'passed'/'failed'."
    ),
)
def wait_job_step(job_id: str, step_seconds: int = 8) -> str:
    import time
    step_seconds = max(1, min(8, int(step_seconds)))
    deadline = time.time() + step_seconds
    last = None
    while time.time() < deadline:
        last = json.loads(get_job_status(job_id))
        job = (last or {}).get("job", {})
        status = job.get("status")
        if status in {"generated", "passed", "failed"}:
            break
        time.sleep(1)
    return json.dumps(last or {"ok": False, "error": "no status"})


@mcp.tool(
    name="check_status",
    description=(
        "Convenience tool: poll a job up to 20s and return status, progress, and a brief summary. "
        "If not finished, call again later."
    ),
)
def check_status(job_id: str) -> str:
    import time
    # Poll in 8s + 8s + 4s chunks to stay under tool caps
    chunks = [8, 8, 4]
    last_response = None
    
    for step_seconds in chunks:
        deadline = time.time() + step_seconds
        while time.time() < deadline:
            # Make direct HTTP request instead of calling other tool functions
            url = build_api_url(f"/api/job/{job_id}")
            try:
                resp = requests.get(url, timeout=min(API_TIMEOUT_SECONDS, 8))
                try:
                    data = resp.json()
                except Exception:
                    data = {"text": resp.text[:500]}
                
                last_response = {
                    "ok": resp.status_code < 400,
                    "status": resp.status_code,
                    "job": data,
                }
                
                status = data.get("status") if isinstance(data, dict) else None
                if status in {"generated", "passed", "failed"}:
                    return json.dumps(last_response)
                    
            except Exception as exc:
                last_response = {"ok": False, "error": f"failed to get status: {exc}"}
                
            time.sleep(1)
    
    return json.dumps(last_response or {"ok": False, "error": "no status"})


@mcp.tool(
    name="give_feedback",
    description=(
        "Analyze test results and provide actionable feedback to Cursor chat. "
        "Determines if tests passed/failed and provides specific recommendations for fixes or UI improvements."
    ),
)
def give_feedback(
    logs: str,
    screenshot_paths: list[str],
    user_request: str,
    context: str = "",
) -> str:
    """Analyze test results and provide intelligent feedback for Cursor chat.
    
    Args:
        logs: Test execution logs from the last attempt
        screenshot_paths: List of screenshot file paths taken during testing
        user_request: Original user request that triggered the test
        context: Additional context that may be important for analysis
    
    Returns:
        JSON string with intelligent analysis and actionable recommendations
    """
    import base64
    import os
    import re
    
    # Validate inputs
    if not isinstance(logs, str):
        return json.dumps({"ok": False, "error": "logs must be a string"})
    if not isinstance(screenshot_paths, list):
        return json.dumps({"ok": False, "error": "screenshot_paths must be a list"})
    if not isinstance(user_request, str):
        return json.dumps({"ok": False, "error": "user_request must be a string"})
    
    # Analyze test results from logs
    test_failed = False
    test_passed = False
    error_details = []
    
    # Parse logs for test results
    if "Flow Passed" in logs or "[Passed]" in logs:
        test_passed = True
    if "Flow Failed" in logs or "[Failed]" in logs or "Error" in logs:
        test_failed = True
        # Extract error details
        error_lines = [line for line in logs.split('\n') if 'error' in line.lower() or 'failed' in line.lower()]
        error_details = error_lines[:3]  # Limit to first 3 error lines
    
    # Process screenshots with analysis
    processed_screenshots = []
    for screenshot_path in screenshot_paths:
        if not isinstance(screenshot_path, str):
            continue
            
        try:
            # Convert to absolute path if relative
            if not os.path.isabs(screenshot_path):
                # Assume relative to project root
                repo_root = find_git_root(Path.cwd()) or Path.cwd()
                screenshot_path = str(repo_root / screenshot_path)
            
            screenshot_file = Path(screenshot_path)
            if screenshot_file.exists():
                # Read and encode screenshot
                with open(screenshot_file, "rb") as f:
                    image_data = f.read()
                    base64_image = base64.b64encode(image_data).decode('utf-8')
                    
                processed_screenshots.append({
                    "path": str(screenshot_file),
                    "filename": screenshot_file.name,
                    "base64": base64_image,
                    "data": f"data:image/png;base64,{base64_image}",
                    "size": len(image_data),
                    "exists": True
                })
            else:
                processed_screenshots.append({
                    "path": screenshot_path,
                    "filename": Path(screenshot_path).name,
                    "exists": False,
                    "error": "Screenshot file not found"
                })
        except Exception as e:
            processed_screenshots.append({
                "path": screenshot_path,
                "filename": Path(screenshot_path).name if screenshot_path else "unknown",
                "exists": False,
                "error": f"Failed to process screenshot: {e}"
            })
    
    # Generate intelligent feedback based on test results
    if test_failed:
        feedback_message = "🔴 TESTS FAILED - ACTION REQUIRED"
        recommendations = [
            "❌ Test execution failed. Review the error details below.",
            "🔧 Check the generated test logic and fix any issues with element selectors or timing.",
            "🔍 Verify that the UI elements referenced in tests actually exist.",
            "⚡ Consider adding wait conditions or updating element IDs if they've changed."
        ]
        if error_details:
            recommendations.extend([f"📝 Error: {error}" for error in error_details])
            
        action_needed = "Fix the failing tests by addressing the errors above, then re-run the test pipeline."
        cursor_focus = "Debug and fix test failures"
        
    elif test_passed:
        feedback_message = "✅ TESTS PASSED - UI VALIDATION NEEDED"
        recommendations = [
            "🎉 All tests executed successfully!",
            "👀 Please review the screenshots below to validate the UI meets requirements.",
            "📋 Check if the implementation matches the original user request.",
            "🎨 Verify visual design, layout, colors, and user experience.",
            "🔄 If UI needs improvements, make changes and re-test."
        ]
        action_needed = "Review screenshots and validate UI implementation. Make improvements if needed."
        cursor_focus = "Review screenshots for UI validation and user experience"
        
    else:
        feedback_message = "⚠️ UNCLEAR TEST STATUS"
        recommendations = [
            "❓ Test status is unclear from the logs.",
            "📊 Review the logs and screenshots to determine what happened.",
            "🔄 Consider re-running the tests if results are inconclusive."
        ]
        action_needed = "Investigate test results and re-run if necessary."
        cursor_focus = "Investigate unclear test results"
    
    # Create comprehensive feedback response for Cursor chat
    feedback_response = {
        "status": "passed" if test_passed else "failed" if test_failed else "unclear",
        "message": feedback_message,
        "summary": {
            "user_request": user_request,
            "test_passed": test_passed,
            "test_failed": test_failed,
            "screenshots_available": len([s for s in processed_screenshots if s.get("exists", False)]),
            "total_screenshots": len(processed_screenshots),
            "context": context
        },
        "recommendations": recommendations,
        "action_needed": action_needed,
        "screenshots": processed_screenshots,
        "logs_analysis": {
            "total_lines": len(logs.split('\n')),
            "contains_errors": bool(error_details),
            "error_details": error_details,
            "raw_logs": logs
        },
        "cursor_instructions": {
            "next_steps": action_needed,
            "primary_focus": cursor_focus,
            "areas_to_review": [
                "Screenshots for UI validation" if test_passed else "Test failure logs and errors",
                "Implementation vs user requirements comparison",
                "Code improvements needed" if test_passed else "Debug and fix test issues"
            ],
            "suggested_actions": [
                "Examine each screenshot carefully" if test_passed else "Fix the test errors listed above",
                "Compare UI with original user request" if test_passed else "Check element selectors and timing",
                "Make UI/UX improvements if needed" if test_passed else "Re-run tests after fixes"
            ]
        }
    }
    
    return json.dumps(feedback_response, indent=2)


if __name__ == "__main__":
    # Run using stdio transport for MCP over process stdio.
    mcp.run(transport="stdio")


