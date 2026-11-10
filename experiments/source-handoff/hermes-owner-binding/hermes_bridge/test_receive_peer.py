"""Bounded synthetic duplex pipes. No subprocess, real MCP, token, model or DB."""

import asyncio
import contextlib
import io
import json
import queue
import unittest

from hermes_bridge.receive_peer import PeerError, ReceivePeer, frame_object, sequence


class QueueInput:
    def __init__(self):
        self.queue = queue.Queue()

    def readline(self, size):
        raw = self.queue.get(timeout=2)
        return raw[:size]

    def send(self, value):
        raw = json.dumps(value).encode() + b"\n"
        self.queue.put(raw)

    def close(self):
        self.queue.put(b"")


class QueueOutput:
    def __init__(self):
        self.queue = queue.Queue()
        self.frames = []

    def write(self, raw):
        self.frames.append(raw)
        self.queue.put(raw)
        return len(raw)

    def flush(self):
        pass


class Native:
    def __init__(self):
        self.calls = []
        self.dispatched = []
        self.closed = False
        self.failure = False
        self.value = '{"content":[],"structuredContent":{"delivery":null}}'

    async def call_tool(self, name, args, guard):
        self.calls.append((name, args))
        await guard()
        if self.failure:
            raise RuntimeError("PRIVATE_TOKEN PRIVATE_MESSAGE")
        self.dispatched.append((name, args))
        return self.value

    async def aclose(self):
        self.closed = True


class Harness:
    def __init__(self, project=None, *, limit=1048576):
        self.source = QueueInput()
        self.output = QueueOutput()
        self.native = Native()
        self.project_calls = []
        if project is None:

            def project(entry):
                self.project_calls.append(entry)
                return {"event_id": "event-1", "state": "projected"}

        self.peer = ReceivePeer(
            self.source, self.output, self.native, project, max_frame_bytes=limit
        )
        self.task = asyncio.create_task(self.peer.run())

    async def next(self):
        raw = await asyncio.to_thread(self.output.queue.get, True, 1)
        return json.loads(raw)

    def allow(self, frame, allowed=True):
        self.source.send(
            {
                "version": 1,
                "type": "checked",
                "id": frame["id"],
                "check_id": frame["check_id"],
                "allowed": allowed,
            }
        )

    async def finish_request(self):
        while True:
            frame = await self.next()
            if frame["type"] == "check":
                self.allow(frame)
            else:
                return frame

    async def close(self):
        self.source.close()
        try:
            await asyncio.wait_for(self.task, 2)
        finally:
            self.source.close()


def call(identifier=1, name="relay_poll", args=None):
    return {
        "version": 1,
        "type": "call",
        "id": identifier,
        "name": name,
        "args": {} if args is None else args,
    }


class ReceivePeerFrameTests(unittest.TestCase):
    def test_exact_version_one_and_finite_positive_sequences(self):
        self.assertEqual(
            frame_object(b'{"version":1,"type":"call"}\n', 100)["version"], 1
        )
        for version in (True, False, 1.0, "1", 0, 2, None):
            raw = json.dumps({"version": version}).encode() + b"\n"
            with self.subTest(version=version), self.assertRaises(PeerError):
                frame_object(raw, 100)
        for value in (True, False, 0, -1, 1.0, "1", 2**53, None):
            self.assertFalse(sequence(value))
        self.assertTrue(sequence(1))
        self.assertTrue(sequence(2**53 - 1))

    def test_frame_bytes_newline_size_duplicate_keys_and_nan_are_refused(self):
        values = [
            ("text", 100),
            (b'{"version":1}', 100),
            (b'{"version":1}\n', 3),
            (b'{"version":1,"version":1}\n', 100),
            (b'{"version":1,"args":{"x":NaN}}\n', 100),
            (b'{"version":1,"args":{"x":Infinity}}\n', 100),
            (b'{"version":1,"args":{"x":1e999}}\n', 100),
        ]
        for raw, limit in values:
            with self.subTest(raw=raw), self.assertRaises(PeerError):
                frame_object(raw, limit)

    def test_depth_and_node_bounds_are_enforced_before_accept(self):
        nested = None
        for _ in range(65):
            nested = {"x": nested}
        for value in [
            {"version": 1, "args": nested},
            {"version": 1, "args": [0] * 10001},
        ]:
            raw = json.dumps(value).encode() + b"\n"
            with self.assertRaisesRegex(PeerError, "frame_capacity"):
                frame_object(raw, len(raw))

    def test_noninteger_or_unbounded_frame_limits_refuse(self):
        for limit in (True, 1024.0, 1023, 33554433):
            with self.subTest(limit=limit), self.assertRaises(PeerError):
                ReceivePeer(
                    QueueInput(),
                    QueueOutput(),
                    Native(),
                    lambda _: None,
                    max_frame_bytes=limit,
                )

    def test_unknown_fields_operations_and_bad_ids_are_refused(self):
        for frame in [
            {**call(), "extra": "not a capability"},
            call(name="relay_submit"),
            call(name="shell"),
            call(args=[]),
            call(identifier=True),
            call(identifier=0),
            {"version": 1, "type": "project", "id": 1, "entry": []},
        ]:
            peer = ReceivePeer(QueueInput(), QueueOutput(), Native(), lambda _: None)
            with self.subTest(frame=frame), self.assertRaises(PeerError):
                peer.accept(frame)


class ReceivePeerTests(unittest.IsolatedAsyncioTestCase):
    def harness(self, project=None, *, limit=1048576):
        value = Harness(project, limit=limit)
        self.addAsyncCleanup(value.close)
        return value

    async def test_poll_and_ack_only_after_initial_and_native_guards(self):
        h = self.harness()
        for identifier, name in [(1, "relay_poll"), (2, "relay_ack")]:
            h.source.send(call(identifier, name, {"fixed": "synthetic"}))
            initial = await h.next()
            self.assertEqual(
                initial,
                {"version": 1, "type": "check", "id": identifier, "check_id": 1},
            )
            self.assertEqual(len(h.native.calls), identifier - 1)
            h.allow(initial)
            native = await h.next()
            self.assertEqual(native["type"], "check")
            self.assertEqual(native["check_id"], 2)
            self.assertEqual(len(h.native.dispatched), identifier - 1)
            h.allow(native)
            result = await h.next()
            self.assertEqual(result["type"], "result")
            self.assertIsInstance(result["result"], str)
            self.assertEqual(h.native.calls[-1], (name, {"fixed": "synthetic"}))

    async def test_initial_guard_denial_never_enters_native_call(self):
        h = self.harness()
        h.source.send(call())
        h.allow(await h.next(), False)
        self.assertEqual(
            await h.next(),
            {"version": 1, "type": "failure", "id": 1, "reason": "native_call_failed"},
        )
        self.assertEqual(h.native.calls, [])

    async def test_native_guard_denial_prevents_dispatch(self):
        h = self.harness()
        h.source.send(call())
        h.allow(await h.next())
        h.allow(await h.next(), False)
        self.assertEqual((await h.next())["reason"], "native_call_failed")
        self.assertEqual(len(h.native.calls), 1)
        self.assertEqual(h.native.dispatched, [])

    async def test_project_callback_is_serialized_and_receipt_has_no_body(self):
        h = self.harness()
        incoming = {
            "sender_id": "sender-1",
            "message": {"body": "external synthetic data"},
        }
        h.source.send({"version": 1, "type": "project", "id": 1, "entry": incoming})
        initial = await h.next()
        self.assertEqual(h.project_calls, [])
        h.allow(initial)
        committed = await h.next()
        self.assertEqual(h.project_calls, [incoming])
        h.allow(committed)
        frame = await h.next()
        self.assertEqual(frame["type"], "result")
        self.assertEqual(
            json.loads(frame["result"]),
            {"projected": True, "event_id": "event-1", "state": "projected"},
        )
        self.assertEqual(h.native.calls, [])

    async def test_pending_projection_is_not_successful_display(self):
        h = self.harness(lambda _: {"event_id": "event-pending", "state": "pending"})
        h.source.send({"version": 1, "type": "project", "id": 1, "entry": {}})
        result = json.loads((await h.finish_request())["result"])
        self.assertFalse(result["projected"])
        self.assertEqual(result["state"], "pending")

    async def test_projection_and_native_exceptions_emit_fixed_reasons_only(self):
        def broken(_):
            raise RuntimeError("PRIVATE_TOKEN PRIVATE_MESSAGE")

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            h = self.harness(broken)
            h.source.send({"version": 1, "type": "project", "id": 1, "entry": {}})
            self.assertEqual((await h.finish_request())["reason"], "projection_failed")
            h.native.failure = True
            h.source.send(call(2))
            self.assertEqual((await h.finish_request())["reason"], "native_call_failed")
        emitted = b"".join(h.output.frames)
        self.assertNotIn(b"PRIVATE", emitted)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "")

    async def test_eof_rejects_active_guard_and_closes_native(self):
        h = self.harness()
        h.source.send(call())
        await h.next()
        h.source.close()
        self.assertEqual((await h.next())["reason"], "native_call_failed")
        await asyncio.wait_for(h.task, 1)
        self.assertTrue(h.native.closed)
        self.assertEqual(h.native.calls, [])

    async def test_overlapping_call_fails_closed_without_dispatch(self):
        h = self.harness()
        h.source.send(call())
        await h.next()
        h.source.send(call(2))
        self.assertEqual((await h.next())["reason"], "native_call_failed")
        await asyncio.wait_for(h.task, 1)
        self.assertEqual(h.native.calls, [])
        self.assertTrue(h.native.closed)

    async def test_reused_completed_id_does_not_replay_effect(self):
        h = self.harness()
        h.source.send(call())
        self.assertEqual((await h.finish_request())["type"], "result")
        h.source.send(call())
        await asyncio.wait_for(h.task, 1)
        self.assertEqual(len(h.native.dispatched), 1)
        self.assertTrue(h.native.closed)

    async def test_boolean_and_unknown_guard_ids_are_not_capabilities(self):
        for field in ("id", "check_id"):
            h = self.harness()
            h.source.send(call())
            check = await h.next()
            reply = {
                "version": 1,
                "type": "checked",
                "id": check["id"],
                "check_id": check["check_id"],
                "allowed": True,
            }
            reply[field] = True
            h.source.send(reply)
            self.assertEqual((await h.next())["reason"], "native_call_failed")
            await asyncio.wait_for(h.task, 1)
            self.assertEqual(h.native.calls, [])

    async def test_oversized_native_result_becomes_fixed_failure(self):
        h = self.harness(limit=1024)
        h.native.value = "PRIVATE" * 400
        h.source.send(call())
        frame = await h.finish_request()
        self.assertEqual(frame["type"], "failure")
        self.assertEqual(frame["reason"], "native_call_failed")
        self.assertNotIn(b"PRIVATE", b"".join(h.output.frames))

    async def test_malformed_wire_frame_closes_without_logging_raw_input(self):
        h = self.harness()
        h.source.queue.put(b'{"version":1,"PRIVATE_TOKEN":\n')
        await asyncio.wait_for(h.task, 1)
        self.assertEqual(h.native.calls, [])
        self.assertTrue(h.native.closed)
        self.assertEqual(h.output.frames, [])


if __name__ == "__main__":
    unittest.main()
