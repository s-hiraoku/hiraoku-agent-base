"""EXPLICIT OFFLINE fixture. No installed product imports, config, auth or network."""
import asyncio
from datetime import datetime, timezone
import json
import sys
from types import SimpleNamespace

from hermes_bridge.test_receive_native import RuntimeFixture
from hermes_bridge.receive_native import HermesNativeSession, TOOLS
from hermes_bridge.receive_peer import ReceivePeer
from hermes_bridge.outbound_scope import NativeOutboundScope

async def main():
    fixture = RuntimeFixture()
    fixture.catalog.append("hab_discover")
    config = {"url":"https://hab.example/mcp","auth":"oauth","tools":{"include":sorted(TOOLS | {"hab_discover"})}}
    sys.modules["hermes_constants"] = SimpleNamespace(get_hermes_home=lambda: "/fake/profile")
    sys.modules["hermes_cli.config_backend"] = SimpleNamespace(read_config_doc_readonly=lambda _: {"mcp_servers":{"hab":config}})
    Base = fixture.core.ClientSession
    class Session(Base):
        async def call_tool(self, name, *, arguments):
            await super().call_tool(name,arguments=arguments)
            if name == "hab_discover":
                value={"version":1,"source":"hab_registry","observed_at":datetime.now(timezone.utc).isoformat(),
                    "selection_basis":"requested_group_name","connection":{"kind":"authentication_group","id":"fake-group","binding_id":"fake-binding"},
                    "selected_identity":{"agent_id":"fake-agent","address":"worker@demo.hab","registration_state":"active",
                        "authorized_operations":["submit","status"],"authentication_assignment":{"kind":"authentication_group","id":"fake-group","binding_state":"active"}},
                    "host_identity":{"state":"unknown"}}
            elif name in ("hab_submit","hab_status"):
                value={"sender_id":"fake-agent","message_id":"fake-answer","recipient_id":"fake-peer","receipt_id":"fake-receipt",
                    "accepted_at":"2026-11-10T00:00:01.000Z","expires_at":"2026-11-10T01:00:00.000Z","state":"acked"}
            else: raise RuntimeError("fixture_outbound_only")
            return SimpleNamespace(model_dump_json=lambda **_:json.dumps({"content":[{"type":"text","text":json.dumps(value)}],"structuredContent":value}))
    fixture.core.ClientSession=Session
    native=HermesNativeSession("/fake/profile","hab","https://hab.example/mcp",runtime=fixture.runtime,
        outbound_scope=NativeOutboundScope("fake-agent","worker@demo.hab","fake-peer","fake-source","fake-thread",frozenset({"fake-answer"})))
    def no_projection(_): raise RuntimeError("fixture_no_projection")
    await ReceivePeer(sys.stdin.buffer,sys.stdout.buffer,native,no_projection,max_frame_bytes=65536,outbound=True).run()

if __name__ == "__main__": asyncio.run(main())
