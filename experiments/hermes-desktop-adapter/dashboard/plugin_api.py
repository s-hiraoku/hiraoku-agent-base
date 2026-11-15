"""Supported Hermes dashboard plugin router, mounted under /api/plugins/hab-desktop-adapter.

The Hermes gateway owns authentication and selects the profile-local plugin host.
Never mount this router as a standalone unauthenticated public server.
"""
import asyncio
import importlib.util
from pathlib import Path
import sqlite3

from fastapi import APIRouter, Body, HTTPException

_spec = importlib.util.spec_from_file_location("hab_desktop_backend", Path(__file__).with_name("hab_backend.py"))
_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_backend)
router = APIRouter()
ROUTE_TIMEOUT = 50


def adapter():
    # Documented public plugin imports, not Hermes core router/private configuration helpers.
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB

    home = Path(get_hermes_home())

    def existing(session):
        db = SessionDB(db_path=home / "state.db", read_only=True)
        try:
            row = db.get_session(session)
            return bool(row and not row.get("archived") and (db.get_compression_tip(session) or session) == session)
        finally:
            db.close()

    return _backend.Adapter(home, existing)


async def invoke(method, *args):
    try:
        async with asyncio.timeout(ROUTE_TIMEOUT):
            return await getattr(adapter(), method)(*args)
    except (OSError, ValueError, TypeError, RuntimeError, sqlite3.Error):
        # Never expose private HAB command output, config, or received text in diagnostics.
        raise HTTPException(status_code=503, detail="HAB adapter is unavailable") from None


@router.get("/binding")
async def binding():
    return await invoke("binding")


@router.post("/sessions/{session_id}/query")
async def query(session_id: str, body: dict = Body(...)):
    return await invoke("query", session_id, body)


@router.post("/sessions/{session_id}/decision")
async def decision(session_id: str, body: dict = Body(...)):
    return await invoke("decide", session_id, body)
