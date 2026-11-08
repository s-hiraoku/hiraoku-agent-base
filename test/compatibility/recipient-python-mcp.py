"""Finite standard Python MCP-client check; no Hermes imports, model, or profile."""
import asyncio
import importlib.metadata
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def check():
    """Exercise the recipient tools against the parent-owned synthetic host."""
    node, fixture, mode = sys.argv[1:]
    params = StdioServerParameters(command=node, args=[fixture], env={
        "HAB_TEST_BROKER_FILE": os.environ["HAB_TEST_BROKER_FILE"],
        "HAB_TEST_COMPATIBILITY": mode,
        "HAB_TEST_COMPATIBILITY_PID_FILE": os.environ["HAB_TEST_COMPATIBILITY_PID_FILE"],
        "TMPDIR": os.environ["TMPDIR"],
        "HOME": os.environ["HOME"],
        "NODE_NO_WARNINGS": "1",
    })
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            with open(os.environ["HAB_TEST_COMPATIBILITY_PID_FILE"], encoding="ascii") as pid_file:
                fixture_pid = int(pid_file.read())
            assert os.getpgid(fixture_pid) == fixture_pid, "SDK must own a distinct fixture process group"
            names = {t.name for t in (await session.list_tools()).tools}
            assert names == {"recipient_" + n for n in (
                "receive", "inbox", "inbox_read", "answer_prepare", "answer_inspect", "answer_enqueue", "send")}

            async def call(op, args=None, error=False):
                result = await session.call_tool("recipient_" + op, arguments=args or {})
                wire = result.model_dump(by_alias=True)
                assert bool(wire.get("isError")) == error, (op, wire.get("isError"))
                assert len(result.content) == 1 and result.content[0].type == "text"
                if error and not result.content[0].text.startswith("{"):
                    return {"protocol_rejection": True}
                return json.loads(result.content[0].text)

            if mode == "paused":
                await call("receive", error=True)
                await call("send", error=True)
                assert (await call("inbox", error=True))["error"] == "recipient_host_unavailable"
            else:
                await call("receive")
                entries = (await call("inbox"))["result"]["value"]
                assert len(entries) == 1
                source = {k: entries[0][k] for k in ("sender_id", "message_id")}
                for extra in ({"context": {}}, {"op": "send"}, {"authorization": True}):
                    await call("inbox_read", {"source": source, **extra}, error=True)
                saved = await call("inbox_read", {"source": source})
                assert saved["origin"] == "external_agent"
                assert saved["result"]["value"]["receipt_confirmed"] is True
                assert saved["result"]["value"]["message"]["body"]["parts"][0]["text"] == "Synthetic external question"
                if mode == "revoked":
                    await call("inbox_read", {"source": source}, error=True)
                    await call("answer_prepare", {"source": source, "body": {"parts": [{"type": "text", "text": "Synthetic stdio answer"}]}}, error=True)
                    await call("send", error=True)
                else:
                    await call("answer_prepare", {"source": source, "body": {"parts": [{"type": "text", "text": "Synthetic stdio answer"}]}})
                    await call("answer_enqueue", {"source": source})
                    await call("answer_enqueue", {"source": source})
                    await call("answer_inspect", {"source": source})
                    await call("send")
            assert len((await session.list_tools()).tools) == 7
    print(json.dumps({"mode": mode, "sdk": importlib.metadata.version("mcp"), "passed": True}))


async def main():
    """Bound handshake, calls and SDK teardown as one finite exercise."""
    async with asyncio.timeout(25):
        await check()


asyncio.run(main())
