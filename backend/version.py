"""
One source of truth for "which build is this?".

Three consumers, and they must never disagree:

  * the browser tab open right now  -- polls /api/version and offers a reload
  * a PWA installed on someone's PC -- same, plus a service-worker cache swap
  * a git clone running on someone's own machine -- compares against GitHub
    and offers to pull

The version itself lives in the repo-root VERSION file, so bumping a release
is a one-line edit. `commit` comes from git when available, which is what
actually distinguishes two builds of the same version during development --
without it, "1.1.0" would look identical before and after every edit and the
update prompt would never fire while we are iterating on the server.
"""

from __future__ import annotations

import os
import subprocess
import time
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = REPO_ROOT / "VERSION"

#: The public repository, used by locally-cloned installs to check for updates.
GITHUB_REPO = "holarxmanuel/ecg-heart-visualizer"
GITHUB_BRANCH = "main"


def read_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _git(*args: str) -> str | None:
    """Run a git command in the repo, returning None if git or the repo is absent."""
    try:
        out = subprocess.run(
            ("git", *args),
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def git_commit() -> str | None:
    return _git("rev-parse", "--short=9", "HEAD")


def git_dirty() -> bool:
    status = _git("status", "--porcelain")
    return bool(status)


def is_git_clone() -> bool:
    return (REPO_ROOT / ".git").exists()


@lru_cache(maxsize=1)
def _boot_time() -> float:
    return time.time()


def build_id() -> str:
    """
    The string the browser actually compares against.

    Version alone is too coarse (it does not change between commits) and the
    commit alone is too fine for a human to read in the UI, so use both. A
    dirty working tree gets a mtime suffix: during development the code changes
    without the commit changing, and an update prompt that cannot fire is worse
    than no update prompt at all.
    """
    version = read_version()
    commit = git_commit()
    if not commit:
        return version
    ident = f"{version}+{commit}"
    if git_dirty():
        # Newest mtime across tracked source, so an edit-save produces a new id.
        newest = 0.0
        for pattern in ("backend/**/*.py", "frontend/src/**/*", "frontend/index.html"):
            for path in REPO_ROOT.glob(pattern):
                if path.is_file():
                    newest = max(newest, path.stat().st_mtime)
        ident += f".dev{int(newest)}"
    return ident


def info() -> dict:
    """The /api/version payload."""
    return {
        "version": read_version(),
        "commit": git_commit(),
        "build_id": build_id(),
        "dirty": git_dirty(),
        "is_git_clone": is_git_clone(),
        "repo": GITHUB_REPO,
        "branch": GITHUB_BRANCH,
        "started_at": _boot_time(),
        "server_time": time.time(),
    }
