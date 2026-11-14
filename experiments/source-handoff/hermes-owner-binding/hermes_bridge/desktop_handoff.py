"""Hands one user-approved HAB request to an existing Hermes Desktop conversation (ADR-021).

The arrival notifier (``hab-notify``, screen type ``hermes-desktop``) runs this after the user
chose 対応する. It runs once per decision, in the Hermes runtime, with the owning profile's
``HERMES_HOME``. It reads one JSON object on stdin, ``{"session_id", "text", "submission_id"}``.
It uses Hermes's own owner client (``tui_gateway.owner_forward``):

1. ``discover_owner`` finds the ready gateway that serves the profile. It never starts one.
2. ``session.resume`` attaches to that saved conversation.
3. ``prompt.submit`` admits the text into the conversation's durable FIFO.

So the request runs in the same conversation the Desktop shows, not in a new CLI session. It
never calls HAB and never replies: the conversation answers with its own ``hab_reply``.

It prints one JSON line and exits 0 for every answer it can name:

- ``{"result": "queued", "admission_id": ...}``: the owner accepted it. Starting is not confirmed.
- ``{"result": "refused", "reason": ...}``: nothing was sent, or the owner refused before writing
  anything. The reasons are no gateway, a session that does not resume, or a pre-commit refusal.
- ``{"result": "unknown"}``: the prompt may be queued (lost answer, timeout). Never resend it.

Invalid input exits 2 without sending anything.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import sys
from pathlib import Path

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,2047}\Z")
_MAX_TEXT = 256 * 1024
# The owner's refusals raised before its durable write (tui_gateway/owner_forward.py,
# _REFUSED_BEFORE_COMMIT): only these prove that nothing will run.
REFUSED_BEFORE_COMMIT = frozenset({
    "invalid_params", "runtime_draining", "runtime_retired", "profile_mismatch",
    "permission_denied", "not_found", "stale_epoch", "admission_conflict", "queue_full"})


def parse_request(raw: str) -> dict:
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {"session_id", "text", "submission_id"}
            or not isinstance(value["session_id"], str) or not _ID.match(value["session_id"])
            or not isinstance(value["submission_id"], str) or not _ID.match(value["submission_id"])
            or not isinstance(value["text"], str) or not value["text"].strip()
            or len(value["text"].encode()) > _MAX_TEXT):
        raise ValueError("invalid_request")
    return value


def _reason(exc: BaseException):
    data = getattr(exc, "data", None)
    reason = data.get("reason") if isinstance(data, dict) else None
    return reason if isinstance(reason, str) else None


async def submit(request: dict, home: Path, *, discover=None, connect=None) -> dict:
    """Admits ``request["text"]`` into the existing conversation. ``discover``/``connect`` default
    to Hermes's ``discover_owner``/``connect_owner`` (tests pass fakes)."""
    if discover is None or connect is None:
        from tui_gateway.owner_forward import connect_owner, discover_owner
        discover, connect = discover or discover_owner, connect or connect_owner
    try:
        endpoint = discover(home)
    except Exception:
        return {"result": "refused", "reason": "owner_not_running"}
    sent = False
    try:
        async with connect(home, endpoint) as client:
            try:
                attached = await client.rpc("session.resume", session_id=request["session_id"])
            except Exception as exc:
                return {"result": "refused", "reason": _reason(exc) or "resume_failed"}
            target = attached.get("session_id") if isinstance(attached, dict) else None
            target = target if isinstance(target, str) and target else request["session_id"]
            sent = True
            receipt = await client.rpc("prompt.submit", session_id=target, text=request["text"],
                                       submission_id=request["submission_id"])
            admission = receipt.get("admission_id") if isinstance(receipt, dict) else None
            return {"result": "queued", "session_id": target,
                    **({"admission_id": admission} if isinstance(admission, str) else {})}
    except Exception as exc:
        reason = _reason(exc)
        if sent and reason not in REFUSED_BEFORE_COMMIT:
            return {"result": "unknown"}
        return {"result": "refused", "reason": reason or "connect_failed"}


def main(stdin=None, stdout=None) -> int:
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        request = parse_request(stdin.read(_MAX_TEXT * 2))
    except (ValueError, TypeError):
        print(json.dumps({"result": "refused", "reason": "invalid_request"}), file=stdout)
        return 2
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    with contextlib.suppress(Exception):
        sys.path.insert(0, str(Path(os.environ["HERMES_SOURCE"]).resolve()))
    print(json.dumps(asyncio.run(submit(request, home))), file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
