"""Killable yt-dlp subprocess execution."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence

from .errors import ServiceError, classify_ytdlp_failure

logger = logging.getLogger("avgrab")


@dataclass
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[Sequence[str], float, Path], Awaitable[ProcessResult]]


async def run_process(argv: Sequence[str], timeout: float, cwd: Path) -> ProcessResult:
    """Run argv, killing the whole process group (yt-dlp + ffmpeg) on timeout."""
    kwargs: dict[str, Any] = {}
    if sys.platform != "win32":
        kwargs["start_new_session"] = True
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **kwargs,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        _kill(proc)
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass
        raise
    return ProcessResult(proc.returncode or 0, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"))


def _kill(proc: asyncio.subprocess.Process) -> None:
    try:
        if sys.platform != "win32":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except ProcessLookupError:
        pass


class YtDlp:
    def __init__(self, binary: str, extra_args: Sequence[str] = (), runner: Runner = run_process):
        self.binary = binary
        self.extra_args = tuple(extra_args)
        self.runner = runner

    def base_args(self, cookie_file: Path | None, playlist: bool = False) -> list[str]:
        args = [
            self.binary,
            "--ignore-config",
            "--yes-playlist" if playlist else "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--no-cache-dir",
            "--socket-timeout", "20",
            "--retries", "2",
        ]
        if cookie_file is not None:
            args += ["--cookies", str(cookie_file)]
        args += list(self.extra_args)
        return args

    async def run(
        self, args: Sequence[str], timeout: float, cwd: Path, operation: str, tolerate_errors: bool = False
    ) -> ProcessResult:
        try:
            result = await self.runner(list(args), timeout, cwd)
        except asyncio.TimeoutError as exc:
            raise ServiceError(504, f"{operation} timed out after {int(timeout)}s") from exc
        except FileNotFoundError as exc:
            raise ServiceError(500, "yt-dlp is not installed") from exc
        if result.returncode != 0 and tolerate_errors and result.stdout.lstrip().startswith("{"):
            logger.info("yt-dlp %s completed with non-fatal errors: %s", operation, result.stderr[-500:])
            return result
        if result.returncode != 0:
            logger.info("yt-dlp %s failed: %s", operation, result.stderr[-2000:])
            raise classify_ytdlp_failure(result.stderr)
        return result

    async def info(
        self,
        url: str,
        timeout: float,
        cwd: Path,
        cookie_file: Path | None,
        extra: Sequence[str] = (),
        tolerate_errors: bool = False,
    ) -> dict[str, Any]:
        args = self.base_args(cookie_file) + ["--dump-single-json", "--skip-download", *extra, "--", url]
        result = await self.run(args, timeout, cwd, "metadata extraction", tolerate_errors)
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ServiceError(502, "Extraction failed: extractor returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise ServiceError(502, "Extraction failed: extractor returned invalid JSON")
        return data
