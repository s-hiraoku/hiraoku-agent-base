import asyncio
import contextlib
import io
import json
import unittest
from pathlib import Path

from hermes_bridge import desktop_handoff as handoff


class RpcError(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.data = {"reason": reason}


class FakeClient:
    def __init__(self, *, resume=None, submit=None, tip=None):
        self.calls = []
        self.resume, self.submit, self.tip = resume, submit, tip

    async def rpc(self, method, **params):
        self.calls.append((method, params))
        if method == "session.resume":
            if self.resume:
                raise self.resume
            return {"session_id": self.tip or params["session_id"]}
        if method == "prompt.submit":
            if self.submit:
                raise self.submit
            return {"admission_id": "adm-1"}
        raise AssertionError(method)


def owner(client, *, running=True):
    def discover(home):
        if not running:
            raise RuntimeError("the gateway that owns it is stopped")
        return "endpoint"

    @contextlib.asynccontextmanager
    async def connect(home, endpoint):
        assert endpoint == "endpoint"
        yield client

    return discover, connect


REQUEST = {"session_id": "20261114_101500_ab12cd", "text": "利用者が「対応する」を選びました。",
           "submission_id": "hab-agent-a-m1"}


def run(client, **kw):
    discover, connect = owner(client, **kw)
    return asyncio.run(handoff.submit(dict(REQUEST), Path("/home"), discover=discover, connect=connect))


class DesktopHandoffTest(unittest.TestCase):
    def test_admits_into_the_resumed_conversation_once(self):
        client = FakeClient()
        self.assertEqual(run(client), {"result": "queued", "session_id": REQUEST["session_id"],
                                       "admission_id": "adm-1"})
        self.assertEqual([m for m, _ in client.calls], ["session.resume", "prompt.submit"])
        self.assertEqual(client.calls[1][1], {"session_id": REQUEST["session_id"], "text": REQUEST["text"],
                                              "submission_id": "hab-agent-a-m1"})

    def test_follows_the_compression_tip_of_the_same_conversation(self):
        client = FakeClient(tip="20261114_tip")
        self.assertEqual(run(client)["session_id"], "20261114_tip")
        self.assertEqual(client.calls[1][1]["session_id"], "20261114_tip")

    def test_no_gateway_or_no_session_sends_nothing(self):
        client = FakeClient()
        self.assertEqual(run(client, running=False), {"result": "refused", "reason": "owner_not_running"})
        self.assertEqual(client.calls, [])
        client = FakeClient(resume=RpcError("not_found"))
        self.assertEqual(run(client), {"result": "refused", "reason": "not_found"})
        self.assertEqual([m for m, _ in client.calls], ["session.resume"])

    def test_after_sending_only_a_pre_commit_refusal_counts_as_not_queued(self):
        self.assertEqual(run(FakeClient(submit=RpcError("queue_full"))),
                         {"result": "refused", "reason": "queue_full"})
        self.assertEqual(run(FakeClient(submit=RpcError("storage_unavailable"))), {"result": "unknown"})
        self.assertEqual(run(FakeClient(submit=TimeoutError())), {"result": "unknown"})

    def test_rejects_bad_input_without_sending(self):
        for bad in ["", "[]", json.dumps({**REQUEST, "extra": 1}), json.dumps({**REQUEST, "text": " "}),
                    json.dumps({**REQUEST, "session_id": "../x"})]:
            out = io.StringIO()
            self.assertEqual(handoff.main(io.StringIO(bad), out), 2)
            self.assertEqual(json.loads(out.getvalue())["result"], "refused")


if __name__ == "__main__":
    unittest.main()
