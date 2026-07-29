"""
Keeping a locally-installed copy in step with the server.

There are two ways to run this system and they must never drift apart:

  1. the hosted deployment -- whatever is on the server right now, which every
     web visitor sees the moment it changes
  2. a git clone on someone's own PC, run against their own localhost

(2) can silently rot. This module lets a local instance notice that the
published version has moved on, tell the user, and -- only with an explicit
click -- pull and rebuild.

The safety rule here is worth stating plainly: `apply()` runs git and npm on
the host. On the public deployment that would be a remote code execution path
for anyone who can reach the port, so main.py restricts the endpoint to
loopback callers and this module refuses to touch a dirty working tree.
"""

from __future__ import annotations

import ipaddress
import json
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any

import version as version_info

REPO_ROOT = version_info.REPO_ROOT
RAW_VERSION_URL = (
    f"https://raw.githubusercontent.com/{version_info.GITHUB_REPO}/"
    f"{version_info.GITHUB_BRANCH}/VERSION"
)
COMMITS_API = (
    f"https://api.github.com/repos/{version_info.GITHUB_REPO}/commits/"
    f"{version_info.GITHUB_BRANCH}"
)

#: Cache the upstream lookup. Every open tab polls, and GitHub rate-limits
#: unauthenticated API calls to 60/hour per IP -- easily exhausted otherwise.
_CACHE: dict[str, Any] = {"at": 0.0, "data": None}
_CACHE_TTL = 300.0


def is_local_request(host: str) -> bool:
    """True only for loopback callers. Anything unparseable is treated as remote."""
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "::1")


def _fetch(url: str, accept: str = "text/plain", timeout: float = 6.0) -> str | None:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "ecg-heart-visualizer-updater",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except (urllib.error.URLError, OSError, UnicodeDecodeError):
        # Offline, rate-limited, or the repo is private. All of these mean the
        # same thing to the caller: we cannot say whether an update exists.
        return None


def _parse_version(text: str) -> tuple[int, ...]:
    """'1.2.3' -> (1,2,3). Unparseable parts sort as 0 rather than raising."""
    parts = []
    for chunk in text.strip().split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts) or (0,)


def check(force: bool = False) -> dict[str, Any]:
    """
    Compare this checkout against the published version on GitHub.

    Never raises: an update check that breaks the app when the network is down
    would be worse than no update check.
    """
    now = time.time()
    if not force and _CACHE["data"] is not None and now - _CACHE["at"] < _CACHE_TTL:
        return {**_CACHE["data"], "cached": True}

    local = version_info.read_version()
    local_commit = version_info.git_commit()

    remote_version = _fetch(RAW_VERSION_URL)
    result: dict[str, Any] = {
        "ok": True,
        "checked_at": now,
        "local_version": local,
        "local_commit": local_commit,
        "is_git_clone": version_info.is_git_clone(),
        "dirty": version_info.git_dirty(),
        "repo": version_info.GITHUB_REPO,
        "update_available": False,
        "remote_version": None,
        "remote_commit": None,
        "reachable": remote_version is not None,
        "cached": False,
    }

    if remote_version is None:
        result["detail"] = "Could not reach GitHub to check for updates."
        _CACHE.update(at=now, data=result)
        return result

    remote_version = remote_version.strip()
    result["remote_version"] = remote_version

    commit_json = _fetch(COMMITS_API, accept="application/vnd.github+json")
    if commit_json:
        try:
            result["remote_commit"] = json.loads(commit_json)["sha"][:9]
        except (ValueError, KeyError, TypeError):
            pass

    newer_version = _parse_version(remote_version) > _parse_version(local)
    # A version bump is the deliberate signal, but during active development
    # the version often stays put while commits land. Treat a differing commit
    # as an update too, so a stale clone is still told to pull.
    differing_commit = bool(
        result["remote_commit"] and local_commit and result["remote_commit"] != local_commit
    )
    result["update_available"] = newer_version or differing_commit
    result["reason"] = (
        "version" if newer_version else ("commit" if differing_commit else "up-to-date")
    )

    _CACHE.update(at=now, data=result)
    return result


def _run(*args: str, timeout: int = 300) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args, cwd=REPO_ROOT, capture_output=True, text=True, timeout=timeout
        )
        return proc.returncode == 0, (proc.stdout + proc.stderr).strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)


def apply() -> dict[str, Any]:
    """
    Pull and rebuild. Only ever called for a loopback client (see main.py).

    Refuses on a dirty tree: silently discarding someone's uncommitted work to
    install an update is not a trade this should make on their behalf.
    """
    steps: list[dict[str, Any]] = []

    if not version_info.is_git_clone():
        return {
            "ok": False,
            "error": "Not a git checkout -- reinstall by cloning the repository.",
            "steps": steps,
        }

    if version_info.git_dirty():
        return {
            "ok": False,
            "error": (
                "You have uncommitted local changes. Commit or stash them first "
                "-- the updater will not discard your work."
            ),
            "steps": steps,
        }

    before = version_info.git_commit()

    for label, args, timeout in (
        ("fetch", ("git", "fetch", "--all", "--prune"), 120),
        ("pull", ("git", "pull", "--ff-only"), 120),
        ("frontend deps", ("npm", "--prefix", "frontend", "install"), 600),
        ("frontend build", ("npm", "--prefix", "frontend", "run", "build"), 600),
    ):
        ok, output = _run(*args, timeout=timeout)
        steps.append({"step": label, "ok": ok, "output": output[-2000:]})
        if not ok:
            return {"ok": False, "error": f"{label} failed", "steps": steps}

    after = version_info.git_commit()

    return {
        "ok": True,
        "from_commit": before,
        "to_commit": after,
        "version": version_info.read_version(),
        "changed": before != after,
        "steps": steps,
        # The Python process is still running the old code in memory. systemd
        # (or the user) has to restart it; saying so is more honest than
        # pretending the update is fully live.
        "restart_required": True,
    }
