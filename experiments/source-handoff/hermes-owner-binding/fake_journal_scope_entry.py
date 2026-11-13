"""OFFLINE owned-child fixture. No installed native imports, credentials or network."""
import asyncio
from datetime import datetime, timezone
import json
import os
import sys
from types import SimpleNamespace

from hermes_bridge.test_receive_native import RuntimeFixture
from hermes_bridge.receive_native import HermesNativeSession, TOOLS
from hermes_bridge.receive_peer import ReceivePeer
from hermes_bridge.outbound_scope import NativeOutboundScope, NativeStatusScope


async def main():
    # These nonsecret inputs are produced only by the explicit synthetic test root.
    policy = json.loads(os.environ["HAB_SYNTHETIC_SCOPE"])
    expiry = os.environ["HAB_SYNTHETIC_EXPIRY"]
    mode = policy.pop("mode")
    policy["message_ids"] = frozenset(policy["message_ids"])
    if mode == "status":
        scope = NativeStatusScope(**policy)
    elif mode == "outbound":
        scope = NativeOutboundScope(**policy)
    else:
        raise ValueError("fixture_scope_mode_invalid")
    fixture = RuntimeFixture()
    fixture.catalog.append("hab_discover")
    config = {"url":"https://hab.example/mcp", "auth":"oauth", "tools":{"include":sorted(TOOLS | {"hab_discover"})}}
    sys.modules["hermes_constants"] = SimpleNamespace(get_hermes_home=lambda: "/fake/profile")
    sys.modules["hermes_cli.config_backend"] = SimpleNamespace(read_config_doc_readonly=lambda _: {"mcp_servers":{"hab":config}})
    Base = fixture.core.ClientSession
    class Session(Base):
        async def call_tool(self, name, *, arguments):
            await super().call_tool(name, arguments=arguments)
            if name == "hab_discover":
                value = {"version":1,"source":"hab_registry","observed_at":datetime.now(timezone.utc).isoformat(),
                    "selection_basis":"requested_group_name","connection":{"kind":"authentication_group","id":"fake-group","binding_id":"fake-binding"},
                    "selected_identity":{"agent_id":scope.agent_id,"address":scope.as_address,"registration_state":"active",
                        "authorized_operations":["submit","status"],"authentication_assignment":{"kind":"authentication_group","id":"fake-group","binding_state":"active"}},
                    "host_identity":{"state":"unknown"}}
            elif name in ("hab_submit", "hab_status"):
                if mode == "status" and name != "hab_status": raise AssertionError("status_fixture_must_not_submit")
                value = {"sender_id":scope.agent_id,"message_id":arguments["message_id"],"recipient_id":scope.source_sender_id,
                    "receipt_id":"fake-receipt","accepted_at":datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),
                    "expires_at":expiry,"state":"pending"}
            else:
                raise AssertionError("fixture_outbound_only")
            return SimpleNamespace(model_dump_json=lambda **_:json.dumps({"content":[{"type":"text","text":json.dumps(value)}],"structuredContent":value}))
    fixture.core.ClientSession = Session
    native = HermesNativeSession("/fake/profile", "hab", "https://hab.example/mcp", runtime=fixture.runtime, outbound_scope=scope)
    def no_projection(_): raise AssertionError("fixture_no_projection")
    await ReceivePeer(sys.stdin.buffer, sys.stdout.buffer, native, no_projection, max_frame_bytes=65536, outbound=True).run()


if __name__ == "__main__": asyncio.run(main())
