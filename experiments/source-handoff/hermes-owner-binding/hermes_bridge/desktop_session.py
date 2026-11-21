"""Tells the arrival notifier whether its bound Hermes Desktop session can display cards (ADR-032).

``hab-notify`` (screen type ``hermes-desktop``, ``session_probe``) runs this when HAB rings its
doorbell and before each check, in the Hermes runtime with the owning profile's ``HERMES_HOME``.
It reads one JSON object on stdin, ``{"session_id"}``, opens the profile's ``state.db`` read-only
through Hermes's own ``hermes_state.SessionDB`` and prints one JSON line:

- ``{"result": "present"}``: the bound session can still display the notice.
- ``{"result": "gone"}``: the bound session is missing, archived or continued under a
  new ID. After compression, bind the notifier to the new ID.
- ``{"result": "unknown"}``: anything else (no ``state.db``, an import or read failure). The
  notifier waits for a confirmed result before checking the inbox.

It never writes, never starts Hermes and never calls HAB. Invalid input exits 2.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
from pathlib import Path

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,2047}\Z")


def parse_request(raw: str) -> str:
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {"session_id"}
            or not isinstance(value["session_id"], str) or not _ID.match(value["session_id"])):
        raise ValueError("invalid_request")
    return value["session_id"]


def _open_session_db(path: Path):
    from hermes_state import SessionDB
    return SessionDB(db_path=path, read_only=True)


def presence(session_id: str, home: Path, *, open_db=None) -> dict:
    """``open_db`` defaults to Hermes's read-only ``SessionDB`` (tests pass a fake)."""
    path = home / "state.db"
    # A missing database is not proof that the conversation ended (a moved or new profile).
    if not path.is_file():
        return {"result": "unknown", "reason": "no_state_db"}
    try:
        db = (open_db or _open_session_db)(path)
    except Exception:
        return {"result": "unknown", "reason": "open_failed"}
    try:
        row = db.get_session(session_id)
        if not row:
            return {"result": "gone", "reason": "not_found"}
        if row.get("archived"):
            return {"result": "gone", "reason": "archived"}
        if (db.get_compression_tip(session_id) or session_id) != session_id:
            return {"result": "gone", "reason": "compressed"}
        return {"result": "present"}
    except Exception:
        return {"result": "unknown", "reason": "read_failed"}
    finally:
        with contextlib.suppress(Exception):
            db.close()


def main(stdin=None, stdout=None) -> int:
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        session_id = parse_request(stdin.read(8192))
    except (ValueError, TypeError):
        print(json.dumps({"result": "unknown", "reason": "invalid_request"}), file=stdout)
        return 2
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    with contextlib.suppress(Exception):
        sys.path.insert(0, str(Path(os.environ["HERMES_SOURCE"]).resolve()))
    print(json.dumps(presence(session_id, home)), file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
