"""Private stdio boundary for native MCP and inert inbound event projection."""

import asyncio
import json
import math


class PeerError(Exception):
    pass


def _object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise PeerError("duplicate_json_key")
        out[key] = value
    return out


def _constant(_value):
    raise PeerError("invalid_json_number")


def frame_object(raw, limit):
    if not isinstance(raw, bytes) or len(raw) > limit or not raw.endswith(b"\n"):
        raise PeerError("invalid_frame")
    value = json.loads(
        raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=_constant
    )
    pending = [(value, 1)]
    nodes = 0
    while pending:
        item, depth = pending.pop()
        if isinstance(item, float) and not math.isfinite(item):
            raise PeerError("invalid_json_number")
        nodes += 1
        if depth > 64 or nodes > 10000:
            raise PeerError("frame_capacity")
        children = (
            list(item.values())
            if isinstance(item, dict)
            else item
            if isinstance(item, list)
            else []
        )
        if nodes + len(pending) + len(children) > 10000:
            raise PeerError("frame_capacity")
        pending.extend((child, depth + 1) for child in children)
    if (
        not isinstance(value, dict)
        or type(value.get("version")) is not int
        or value.get("version") != 1
    ):
        raise PeerError("invalid_frame")
    return value


def sequence(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= 2**53 - 1
    )


class ReceivePeer:
    def __init__(self, source, output, native, project, *, max_frame_bytes=1048576, outbound=False):
        if type(max_frame_bytes) is not int or not 1024 <= max_frame_bytes <= 33554432:
            raise PeerError("invalid_frame_limit")
        self.source, self.output = source, output
        self.native, self.project = native, project
        if type(outbound) is not bool:
            raise PeerError("invalid_native_scope")
        # Trusted constructor choice only; incoming frames cannot expand this set.
        self.calls = frozenset(("relay_poll", "relay_ack", "relay_submit", "relay_status") if outbound else ("relay_poll", "relay_ack"))
        self.limit = max_frame_bytes
        self.queue = asyncio.Queue(maxsize=1)
        self.current = None
        self.last_id = 0
        self.check_id = 0
        self.checks = {}
        self.closed = False

    def emit(self, frame):
        raw = (
            json.dumps(
                {"version": 1, **frame}, ensure_ascii=False, separators=(",", ":")
            ).encode()
            + b"\n"
        )
        if len(raw) > self.limit:
            raise PeerError("frame_capacity")
        self.output.write(raw)
        self.output.flush()

    async def guard(self):
        if self.closed or self.current is None:
            raise PeerError("guard_unavailable")
        self.check_id += 1
        key = (self.current, self.check_id)
        future = asyncio.get_running_loop().create_future()
        self.checks[key] = future
        try:
            self.emit({"type": "check", "id": key[0], "check_id": key[1]})
            if await asyncio.wait_for(future, 5) is not True:
                raise PeerError("guard_denied")
        finally:
            self.checks.pop(key, None)

    def accept(self, frame):
        kind = frame.get("type")
        if kind == "checked":
            if (
                set(frame) != {"version", "type", "id", "check_id", "allowed"}
                or not isinstance(frame["allowed"], bool)
                or not sequence(frame["id"])
                or not sequence(frame["check_id"])
            ):
                raise PeerError("invalid_frame")
            key = (frame["id"], frame["check_id"])
            future = self.checks.get(key)
            if future is None or future.done():
                raise PeerError("invalid_guard")
            future.set_result(frame["allowed"])
            return
        expected = (
            {"version", "type", "id", "name", "args"}
            if kind == "call"
            else {"version", "type", "id", "entry"}
        )
        if (
            kind not in ("call", "project")
            or set(frame) != expected
            or not sequence(frame["id"])
        ):
            raise PeerError("invalid_frame")
        if (
            frame["id"] <= self.last_id
            or self.current is not None
            or not self.queue.empty()
        ):
            raise PeerError("duplicate_or_overlapping_call")
        if kind == "call" and (
            frame["name"] not in self.calls
            or not isinstance(frame["args"], dict)
        ):
            raise PeerError("invalid_call")
        if kind == "project" and not isinstance(frame["entry"], dict):
            raise PeerError("invalid_projection")
        self.last_id = frame["id"]
        self.queue.put_nowait(frame)

    async def _read(self):
        try:
            while True:
                raw = await asyncio.to_thread(self.source.readline, self.limit + 1)
                if not raw:
                    break
                self.accept(frame_object(raw, self.limit))
        finally:
            self.closed = True
            for future in self.checks.values():
                if not future.done():
                    future.set_result(False)
            # No new request after EOF; active RPC can settle before cleanup.
            if self.queue.empty():
                self.queue.put_nowait(None)

    async def run(self):
        reader = asyncio.create_task(self._read())
        try:
            while True:
                frame = await self.queue.get()
                if frame is None or self.closed:
                    break
                self.current, self.check_id = frame["id"], 0
                try:
                    await self.guard()
                    if frame["type"] == "call":
                        value = await self.native.call_tool(
                            frame["name"], frame["args"], self.guard
                        )
                    else:
                        receipt = self.project(frame["entry"])
                        await self.guard()
                        value = json.dumps(
                            {"projected": receipt["state"] == "projected", **receipt},
                            ensure_ascii=False,
                        )
                    self.emit({"type": "result", "id": self.current, "result": value})
                except Exception:
                    reason = (
                        "projection_failed"
                        if frame["type"] == "project"
                        else "native_call_failed"
                    )
                    self.emit({"type": "failure", "id": self.current, "reason": reason})
                finally:
                    self.current = None
                if self.closed:
                    break
        finally:
            self.closed = True
            try:
                await self.native.aclose()
            finally:
                # Runs even when native cleanup is unsettled. Cancelling the task
                # does not interrupt a readline already blocked in its worker thread.
                if reader.done():
                    # Observe read/parse failures without copying their body into logs.
                    try:
                        reader.result()
                    except (Exception, asyncio.CancelledError):
                        pass
                else:
                    reader.cancel()
                    try:
                        await reader
                    except asyncio.CancelledError:
                        pass
