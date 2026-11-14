"""Synthetic SDK/httpx/native broker only; no installed accounts, network or models."""

import asyncio
from contextlib import asynccontextmanager, contextmanager
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_bridge.receive_native import (
    HermesNativeSession,
    NativeSessionError,
    NativeSessionUnsettled,
    TOOLS,
)


class RuntimeFixture:
    """Dispatch models the SDK auth wait before the guarded HTTP transport."""

    def __init__(self):
        self.events = []
        self.runtime_calls = 0
        self.provider_calls = []
        self.client_options = []
        self.body_caps = 0
        self.metadata_factories = []
        self.prefetch = False
        self.request_urls = {}
        self.attempts = []
        self.dispatches = []
        self.sessions = []
        self.catalog = sorted(TOOLS)
        self.provider = SimpleNamespace(kind="existing-synthetic-native-provider")
        self.auth_phase = None
        self.auth_started = asyncio.Event()
        self.auth_release = asyncio.Event()
        self.fail_rpc_once = False
        fixture = self

        class Transport:
            def __init__(self, *, retries):
                if retries != 0:
                    raise AssertionError("native_retry_was_enabled")

            async def handle_async_request(self, request):
                fixture.dispatches.append(request)
                if request.startswith("call:") and fixture.fail_rpc_once:
                    fixture.fail_rpc_once = False
                    raise OSError("PRIVATE_PROVIDER_TOKEN_DETAIL")
                return SimpleNamespace(status_code=200)

            async def aclose(self):
                fixture.events.append(("transport.close", asyncio.current_task()))

        class HttpClient:
            def __init__(self, **options):
                fixture.client_options.append(options)
                self.transport = options["transport"]
                self.auth = options["auth"]
                self.owner = None

            async def __aenter__(self):
                self.owner = asyncio.current_task()
                fixture.events.append(("client.enter", self.owner))
                return self

            async def __aexit__(self, *_exc):
                if asyncio.current_task() is not self.owner:
                    raise AssertionError("native_http_context_closed_from_other_task")
                fixture.events.append(("client.exit", asyncio.current_task()))
                await self.transport.aclose()

            async def request(self, phase):
                if phase == "initialize" and self.auth is not None and fixture.prefetch:
                    async with fixture.metadata_factories[-1]() as metadata:
                        await metadata.request("metadata:prm")
                        await metadata.request("metadata:asm")
                # This happens after the provider has prepared/refreshed the request,
                # just before httpx dispatches into GuardedTransport.
                if fixture.auth_phase == phase:
                    fixture.auth_phase = None
                    fixture.auth_started.set()
                    await fixture.auth_release.wait()
                class Request(str): pass
                request = Request(phase)
                request.url = fixture.request_urls.get(phase, "https://hab.example/mcp")
                return await self.transport.handle_async_request(request)

        class Session:
            def __init__(self, read, write):
                if read is not write:
                    raise AssertionError("unexpected_synthetic_streams")
                self.client = read
                self.owner = None
                fixture.sessions.append(self)

            async def __aenter__(self):
                self.owner = asyncio.current_task()
                fixture.events.append(("session.enter", self.owner))
                return self

            async def __aexit__(self, *_exc):
                if asyncio.current_task() is not self.owner:
                    raise AssertionError("native_sdk_context_closed_from_other_task")
                fixture.events.append(("session.exit", asyncio.current_task()))

            async def list_tools(self):
                await self.client.request("tools/list")
                return SimpleNamespace(
                    tools=[SimpleNamespace(name=name) for name in fixture.catalog]
                )

            async def call_tool(self, name, *, arguments):
                fixture.attempts.append((name, copy.deepcopy(arguments)))
                await self.client.request("call:" + name)
                value = {
                    "content": [{"type": "text", "text": '{"delivery":null}'}],
                    "structuredContent": {"delivery": None},
                }

                def dump(**options):
                    if options != {"by_alias": True, "exclude_none": True}:
                        raise AssertionError("result_serialization_changed")
                    return json.dumps(value)

                return SimpleNamespace(model_dump_json=dump)

        class ServerTask:
            def __init__(self, name):
                self.name = name

            async def _negotiate_session(self, session, timeout):
                if self.name != "hab" or timeout != 20.0:
                    raise AssertionError("native_negotiation_changed")
                await session.client.request("initialize")

        @asynccontextmanager
        async def streamable(resource, *, http_client):
            if resource != "https://hab.example/mcp":
                raise AssertionError("resource_changed")
            owner = asyncio.current_task()
            fixture.events.append(("streams.enter", owner))
            try:
                yield (http_client, http_client, lambda: None)
            finally:
                if asyncio.current_task() is not owner:
                    raise AssertionError("native_stream_context_closed_from_other_task")
                fixture.events.append(("streams.exit", asyncio.current_task()))

        self.httpx = SimpleNamespace(
            AsyncBaseTransport=object,
            AsyncHTTPTransport=Transport,
            AsyncClient=HttpClient,
            Timeout=lambda connect, *, read: (connect, read),
        )
        self.core = SimpleNamespace(
            sdk_httpx=lambda: self.httpx,
            ClientSession=Session,
            MCPServerTask=ServerTask,
            LATEST_HANDSHAKE_VERSION="2025-03-26",
            streamable_http_client=streamable,
        )

    @contextmanager
    def suppress(self):
        self.events.append(("interactive.suppressed", asyncio.current_task()))
        try:
            yield
        finally:
            self.events.append(("interactive.restored", asyncio.current_task()))

    def manager(self):
        def get_or_build_provider(name, resource, oauth, *, metadata_client_factory):
            self.metadata_factories.append(metadata_client_factory)
            self.provider_calls.append((name, resource, copy.deepcopy(oauth)))
            return self.provider

        return SimpleNamespace(get_or_build_provider=get_or_build_provider)

    def body_cap(self, httpx, transport):
        if httpx is not self.httpx:
            raise AssertionError("wrong_sdk_httpx")
        self.body_caps += 1
        return transport

    def runtime(self):
        self.runtime_calls += 1
        return self.core, self.suppress, self.manager, self.body_cap


class NativeReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.profile = Path(self.tmp.name).resolve()
        self.cfg_path = self.profile / "config.yaml"
        self.cfg = {
            "url": "https://hab.example/mcp",
            "auth": "oauth",
            "enabled": False,
            "tools": {"include": sorted(TOOLS)},
            "oauth": {
                "client_id": "public-fixture-client",
                "scopes": [
                    "hab:resolve",
                    "hab:submit",
                    "hab:status",
                    "hab:poll",
                    "hab:ack",
                    "offline_access",
                ],
            },
        }
        self.write_config(self.cfg)
        # Model the supported backend API without importing an installed profile.
        self.yaml_patch = patch.dict(
            sys.modules, {"hermes_constants": SimpleNamespace(get_hermes_home=lambda: self.profile), "hermes_cli.config_backend": SimpleNamespace(
                read_config_doc_readonly=lambda path: json.loads(path.read_bytes())
            )}
        )
        self.yaml_patch.start()
        self.runtime = RuntimeFixture()

    async def asyncTearDown(self):
        self.yaml_patch.stop()
        self.tmp.cleanup()

    def write_config(self, cfg):
        self.cfg_path.write_text(json.dumps({"mcp_servers": {"hab": cfg}}))
        self.cfg_path.chmod(0o600)

    def session(self):
        return HermesNativeSession(
            self.profile,
            "hab",
            "https://hab.example/mcp",
            runtime=self.runtime.runtime,
        )

    async def test_supported_profile_backend_is_used_without_a_yaml_file(self):
        self.cfg_path.unlink()
        reads = []

        def read(path):
            reads.append(path)
            return {"mcp_servers": {"hab": self.cfg}}

        async def guard():
            pass

        with patch.dict(sys.modules, {"hermes_cli.config_backend": SimpleNamespace(
            read_config_doc_readonly=read
        )}):
            await self.session().call_tool("hab_poll", {}, guard)
        self.assertEqual(reads, [self.cfg_path])
        self.assertFalse(self.cfg_path.exists())

    async def test_existing_broker_and_fixed_resource_are_reused_without_token_copy(
        self,
    ):
        session = self.session()
        before = self.cfg_path.read_bytes()
        read_paths = []
        original_read = Path.read_bytes

        def read(path):
            read_paths.append(path)
            return original_read(path)

        checks = []

        async def guard():
            checks.append(asyncio.current_task())

        with patch.object(Path, "read_bytes", read):
            value = await session.call_tool(
                "hab_poll", {"as_address": "worker@demo.hab"}, guard
            )
            await session.aclose()
        self.assertIsNone(json.loads(value)["structuredContent"]["delivery"])
        self.assertEqual(read_paths, [self.cfg_path])
        self.assertEqual(self.cfg_path.read_bytes(), before)
        self.assertEqual(
            self.runtime.provider_calls,
            [("hab", self.cfg["url"], self.cfg["oauth"])],
        )
        self.assertIs(self.runtime.client_options[0]["auth"], self.runtime.provider)
        self.assertEqual(self.runtime.client_options[0]["follow_redirects"], False)
        self.assertEqual(
            self.runtime.client_options[0]["headers"],
            {"MCP-Protocol-Version": "2025-03-26"},
        )
        self.assertEqual(self.runtime.body_caps, 1)
        self.assertEqual(
            self.runtime.dispatches, ["initialize", "tools/list", "call:hab_poll"]
        )
        self.assertGreaterEqual(len(checks), 5)
        self.assertTrue(
            all(task is asyncio.current_task() for _, task in self.runtime.events)
        )
        self.assertEqual(
            [name for name, _ in self.runtime.events][-5:],
            [
                "session.exit",
                "streams.exit",
                "client.exit",
                "transport.close",
                "interactive.restored",
            ],
        )

    async def test_uncertain_cleanup_never_publishes_a_native_result_or_replays_rpc(
        self,
    ):
        session = self.session()

        async def guard():
            pass

        async def broken_close(_transport):
            raise RuntimeError("PRIVATE_CLEANUP_DETAIL")

        with patch.object(
            self.runtime.httpx.AsyncHTTPTransport, "aclose", broken_close
        ):
            with self.assertRaises(NativeSessionUnsettled):
                await session.call_tool("hab_poll", {}, guard)
        self.assertEqual(self.runtime.attempts, [("hab_poll", {})])
        with self.assertRaises(NativeSessionUnsettled):
            await session.aclose()
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("hab_poll", {}, guard)
        self.assertEqual(len(self.runtime.attempts), 1)

    async def test_sdk_context_is_closed_before_the_native_result_is_published(self):
        session = self.session()

        async def guard():
            pass

        for index in range(2):
            value = await session.call_tool("hab_poll", {}, guard)
            self.assertIsNone(json.loads(value)["structuredContent"]["delivery"])
            self.assertIsNone(session._session)
            self.assertIsNone(session._stack)
            names = [name for name, _ in self.runtime.events]
            self.assertEqual(names.count("session.exit"), index + 1)
            self.assertEqual(names.count("streams.exit"), index + 1)
            self.assertEqual(names.count("client.exit"), index + 1)
            self.assertEqual(names.count("transport.close"), index + 1)
        self.assertEqual(len(self.runtime.sessions), 2)
        self.assertTrue(
            all(task is asyncio.current_task() for _, task in self.runtime.events)
        )
        before = list(self.runtime.events)
        await session.aclose()
        self.assertEqual(self.runtime.events, before)

    async def test_guard_after_synthetic_refresh_wait_prevents_rpc_dispatch(self):
        session = self.session()
        self.runtime.auth_phase = "call:hab_poll"
        allowed = True

        async def guard():
            if not allowed:
                raise PermissionError("PRIVATE_ACTOR_DETAIL")

        pending = asyncio.create_task(session.call_tool("hab_poll", {}, guard))
        await asyncio.wait_for(self.runtime.auth_started.wait(), 1)
        allowed = False
        self.runtime.auth_release.set()
        with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
            await pending
        self.assertEqual(self.runtime.dispatches, ["initialize", "tools/list"])
        self.assertIsNone(session._session)
        self.assertEqual(len(self.runtime.sessions), 1)
        self.assertTrue(all(task is pending for _, task in self.runtime.events))

    async def test_only_poll_and_ack_are_callable(self):
        session = self.session()

        async def guard():
            self.fail("forbidden_tool_reached_guard")

        for name in ("hab_submit", "hab_status", "hab_resolve", "hab_discover", "hab_register", "shell", None):
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(NativeSessionError, "^native_call_refused$"),
            ):
                await session.call_tool(name, {}, guard)
        self.assertEqual(self.runtime.runtime_calls, 0)
        self.assertEqual(self.runtime.dispatches, [])

    async def test_known_additive_catalogs_preserve_receive_only_calls(self):
        async def guard():
            pass

        variants = [set(), {"hab_discover"}, {"hab_register"}, {"hab_discover", "hab_register"}]
        for configured in variants:
            for remote in variants:
                with self.subTest(configured=configured, remote=remote):
                    self.write_config({**self.cfg, "tools": {"include": sorted(TOOLS | configured)}})
                    self.runtime.catalog = sorted(TOOLS | remote)
                    await self.session().call_tool("hab_poll", {}, guard)
        self.assertEqual(len(self.runtime.attempts), 16)
        self.assertTrue(all(name == "hab_poll" for name, _ in self.runtime.attempts))

    async def test_incomplete_unknown_and_duplicate_catalogs_never_dispatch_business_rpc(self):
        async def guard():
            pass

        bad = [sorted(TOOLS - {"hab_ack"}), sorted(TOOLS | {"shell"}), sorted(TOOLS) + ["hab_poll"]]
        for catalog in bad:
            for local in (True, False):
                with self.subTest(catalog=catalog, local=local):
                    self.write_config({**self.cfg, "tools": {"include": catalog if local else sorted(TOOLS)}})
                    self.runtime.catalog = sorted(TOOLS) if local else catalog
                    with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
                        await self.session().call_tool("hab_poll", {}, guard)
        self.assertEqual(self.runtime.attempts, [])

    async def test_task_catalog_is_known_but_task_calls_remain_refused(self):
        task_tools = {"hab_task_send", "hab_task_get", "hab_task_list", "hab_task_cancel"}
        self.runtime.catalog = sorted(TOOLS | {"hab_discover"} | task_tools)

        async def guard():
            pass

        session = self.session()
        result = await session.call_tool("hab_poll", {}, guard)
        self.assertIsNone(json.loads(result)["structuredContent"]["delivery"])
        for tool in task_tools:
            with self.assertRaisesRegex(NativeSessionError, "^native_call_refused$"):
                await session.call_tool(tool, {}, guard)
        self.assertEqual([name for name, _ in self.runtime.attempts], ["hab_poll"])

    async def test_partial_task_catalog_is_rejected_before_receiving(self):
        self.runtime.catalog = sorted(TOOLS | {"hab_task_send"})

        async def guard():
            pass

        with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
            await self.session().call_tool("hab_poll", {}, guard)
        self.assertEqual(self.runtime.attempts, [])

    async def test_config_mismatch_refuses_before_runtime_or_oauth_provider(self):
        changes = [
            {"url": "https://other.example/mcp"},
            {"auth": "none"},
            {"ssl_verify": False},
            {"headers": {"Authorization": "synthetic-private-header"}},
            {"tools": {"include": sorted(TOOLS | {"shell"})}},
            {"tools": {"include": ["hab_poll"]}},
            {"transport": "sse"},
        ]

        async def guard():
            pass

        for change in changes:
            with self.subTest(change=change):
                self.write_config({**self.cfg, **change})
                with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
                    await self.session().call_tool("hab_poll", {}, guard)
        self.assertEqual(self.runtime.runtime_calls, 0)
        self.assertEqual(self.runtime.provider_calls, [])

    async def test_wrong_remote_tool_catalog_closes_context_without_business_rpc(self):
        self.runtime.catalog = sorted(TOOLS | {"shell"})
        session = self.session()

        async def guard():
            pass

        with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
            await session.call_tool("hab_poll", {}, guard)
        self.assertEqual(self.runtime.dispatches, ["initialize", "tools/list"])
        self.assertEqual(self.runtime.attempts, [])
        self.assertIsNone(session._stack)
        self.assertIn("session.exit", [name for name, _ in self.runtime.events])
        self.assertIn("client.exit", [name for name, _ in self.runtime.events])

    async def test_rpc_error_does_not_replay_and_next_request_opens_fresh_session(self):
        session = self.session()
        self.runtime.fail_rpc_once = True

        async def guard():
            pass

        args = {
            "sender_id": "source",
            "message_id": "message",
            "request_id": "same-ack",
        }
        with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
            await session.call_tool("hab_ack", args, guard)
        self.assertEqual(self.runtime.attempts, [("hab_ack", args)])
        self.assertEqual(self.runtime.dispatches.count("call:hab_ack"), 1)
        self.assertIsNone(session._session)
        await session.call_tool("hab_ack", args, guard)
        self.assertEqual(len(self.runtime.sessions), 2)
        self.assertEqual(
            self.runtime.attempts, [("hab_ack", args), ("hab_ack", args)]
        )
        self.assertEqual(self.runtime.dispatches.count("call:hab_ack"), 2)
        await session.aclose()
        self.assertTrue(
            all(task is asyncio.current_task() for _, task in self.runtime.events)
        )

    async def test_overlapping_call_is_refused_without_second_native_request(self):
        session = self.session()
        self.runtime.auth_phase = "call:hab_poll"

        async def guard():
            pass

        async def owner():
            try:
                return await session.call_tool("hab_poll", {}, guard)
            finally:
                await session.aclose()

        pending = asyncio.create_task(owner())
        await asyncio.wait_for(self.runtime.auth_started.wait(), 1)
        with self.assertRaisesRegex(NativeSessionError, "^native_call_refused$"):
            await session.call_tool("hab_ack", {}, guard)
        self.runtime.auth_release.set()
        await pending
        self.assertEqual(self.runtime.attempts, [("hab_poll", {})])
        self.assertTrue(all(task is pending for _, task in self.runtime.events))


if __name__ == "__main__":
    unittest.main()
