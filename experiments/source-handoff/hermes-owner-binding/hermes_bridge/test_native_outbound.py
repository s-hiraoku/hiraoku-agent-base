"""OFFLINE: synthetic native SDK, OAuth manager and remote response only."""
import asyncio
import builtins
import copy
from datetime import datetime, timezone
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_bridge import test_receive_native as old_tests
from hermes_bridge.receive_native import HermesNativeSession, NativeSessionError, NativeSessionUnsettled
from hermes_bridge.outbound_scope import NativeOutboundScope, NativeStatusScope

ExceptionGroupType = getattr(builtins, "BaseExceptionGroup", None)


class NativeOutboundTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = old_tests.NativeReceiveTests.asyncSetUp
    asyncTearDown = old_tests.NativeReceiveTests.asyncTearDown
    write_config = old_tests.NativeReceiveTests.write_config

    def prepare(self):
        self.scope = NativeOutboundScope("fake-agent", "worker@demo.hab", "fake-peer", "fake-source", "fake-thread", frozenset({"fake-answer"}))
        self.runtime.catalog.append("hab_discover")
        self.cfg["tools"]["include"].append("hab_discover")
        self.write_config(self.cfg)
        self.who = {
            "version":1, "source":"hab_registry", "observed_at":datetime.now(timezone.utc).isoformat(),
            "selection_basis":"requested_group_name", "connection":{
                "kind":"authentication_group", "id":"fake-group", "binding_id":"fake-binding"},
            "selected_identity":{
                "agent_id":"fake-agent", "address":"worker@demo.hab", "registration_state":"active",
                "authorized_operations":["poll","ack","submit","status","resolve"],
                "authentication_assignment":{"kind":"authentication_group","id":"fake-group","binding_state":"active"}},
            # This deliberately does not attest a native host or mint any local identity.
            "host_identity":{"state":"unknown"}}
        self.message = {"version":1, "message_id":"fake-answer", "recipient_id":"fake-peer", "kind":"answer",
            "body":{"parts":[{"type":"text","text":"fixture only"}]}, "thread_id":"fake-thread",
            "in_reply_to":{"sender_id":"fake-peer","message_id":"fake-source"},
            "first_sent_at":"2026-11-10T00:00:00.000Z", "expires_at":"2026-11-10T01:00:00.000Z",
            "as_address":"worker@demo.hab", "expected_agent_id":"fake-agent"}
        outer = self
        Base = self.runtime.core.ClientSession
        class Session(Base):
            async def call_tool(self, name, *, arguments):
                result = await super().call_tool(name, arguments=arguments)
                if name != "hab_discover": return result
                value = {"content":[{"type":"text","text":json.dumps(outer.who)}], "structuredContent":outer.who}
                return SimpleNamespace(model_dump_json=lambda **_:json.dumps(value))
        self.runtime.core.ClientSession = Session
        return HermesNativeSession(self.profile, "hab_relay", "https://relay.example/mcp", runtime=self.runtime.runtime, outbound_scope=self.scope)

    async def guard(self): pass

    async def test_only_native_manager_gets_auth_and_each_outbound_is_bound(self):
        session = self.prepare()
        await session.call_tool("relay_submit", self.message, self.guard)
        await session.call_tool("relay_status", {k:self.message[k] for k in ("message_id","as_address","expected_agent_id")}, self.guard)
        self.assertEqual([n for n,_ in self.runtime.attempts], ["hab_discover","relay_submit","hab_discover","relay_status"])
        self.assertEqual(len(self.runtime.provider_calls), 2)
        self.assertTrue(all(c["auth"] is self.runtime.provider for c in self.runtime.client_options))
        self.assertEqual(self.runtime.attempts[1][1],self.message)
        self.assertIsNone(session._session)

    async def test_default_receive_path_does_not_allow_outbound(self):
        session=HermesNativeSession(self.profile,"hab_relay","https://relay.example/mcp",runtime=self.runtime.runtime)
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",{},self.guard)
        self.assertEqual(self.runtime.runtime_calls,0)

    async def test_claimed_actor_wrong_source_other_message_and_arbitrary_tool_reject_before_connect(self):
        session=self.prepare()
        for key,value in [("expected_agent_id","other"),("recipient_id","other"),("kind","question"),("thread_id","other"),("message_id","other"),("in_reply_to",{"sender_id":"other","message_id":"fake-source"})]:
            args=copy.deepcopy(self.message);args[key]=value
            with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",args,self.guard)
        with self.assertRaises(NativeSessionError): await session.call_tool("hab_register",{},self.guard)
        with self.assertRaises(NativeSessionError): await session.call_tool("hab_discover",{},self.guard)
        self.assertEqual(self.runtime.runtime_calls,0)

    async def test_missing_discovery_fails_without_submit(self):
        session=self.prepare();self.runtime.catalog.remove("hab_discover")
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual(self.runtime.attempts,[])

    async def test_wrong_remote_assignment_refuses_business_call(self):
        session=self.prepare();self.who["selected_identity"]["agent_id"]="other"
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual([n for n,_ in self.runtime.attempts],["hab_discover"])

    async def test_insufficient_remote_operation_and_stale_snapshot_refuse(self):
        session=self.prepare();self.who["selected_identity"]["authorized_operations"]=["poll","ack"]
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",self.message,self.guard)
        session=HermesNativeSession(self.profile,"hab_relay","https://relay.example/mcp",runtime=self.runtime.runtime,outbound_scope=self.scope)
        self.who["selected_identity"]["authorized_operations"]=["submit"]
        self.who["observed_at"]="2000-01-01T00:00:00+00:00"
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual([n for n,_ in self.runtime.attempts],["hab_discover","hab_discover"])

    async def test_identity_replacement_is_terminal_for_old_composition(self):
        session=self.prepare();await session.call_tool("relay_submit",self.message,self.guard)
        self.who["connection"]["binding_id"]="replacement"
        with self.assertRaises(NativeSessionError): await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual([n for n,_ in self.runtime.attempts],["hab_discover","relay_submit","hab_discover"])
        self.who["connection"]["binding_id"]="fake-binding"
        with self.assertRaisesRegex(NativeSessionError,"native_identity_lost"):
            await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual(len(self.runtime.attempts),3)

    async def test_revocation_after_oauth_wait_never_dispatches_submit(self):
        import asyncio
        session=self.prepare();self.runtime.auth_phase="call:relay_submit";live=True
        async def guard():
            if not live: raise RuntimeError("revoked")
        task=asyncio.create_task(session.call_tool("relay_submit",self.message,guard))
        await self.runtime.auth_started.wait();live=False;self.runtime.auth_release.set()
        with self.assertRaises(NativeSessionError): await task
        self.assertNotIn("call:relay_submit",self.runtime.dispatches)

    async def test_lost_submit_response_is_not_replayed(self):
        session=self.prepare()
        Base=self.runtime.core.ClientSession
        class FailSubmit(Base):
            async def call_tool(self,name,*,arguments):
                result=await super().call_tool(name,arguments=arguments)
                if name=="relay_submit": raise RuntimeError("PRIVATE_TOKEN_DETAIL")
                return result
        self.runtime.core.ClientSession=FailSubmit
        with self.assertRaisesRegex(NativeSessionError,"^native_call_failed$"):
            await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual([n for n,_ in self.runtime.attempts],["hab_discover","relay_submit"])

    async def test_native_home_mismatch_refuses_before_provider_or_mcp(self):
        from unittest.mock import patch
        import sys
        session=self.prepare()
        with patch.dict(sys.modules,{"hermes_constants":SimpleNamespace(get_hermes_home=lambda:"/other/profile")}):
            with self.assertRaises(NativeSessionError):
                await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual(self.runtime.provider_calls,[])
        self.assertEqual(self.runtime.attempts,[])

    async def test_real_runtime_refuses_before_native_import_config_or_provider(self):
        from unittest.mock import patch
        import builtins
        real_import=builtins.__import__
        touched=[]
        def guarded_import(name,*args,**kwargs):
            if name.startswith(("hermes_constants","hermes_cli","tools.","mcp.")):
                touched.append(name)
                raise AssertionError("native_import_was_attempted")
            return real_import(name,*args,**kwargs)
        session=HermesNativeSession(self.profile,"hab_relay","https://relay.example/mcp")
        with patch.object(builtins,"__import__",guarded_import):
            with self.assertRaises(NativeSessionError):
                await session.call_tool("relay_poll",{},self.guard)
        self.assertEqual(touched,[])

    async def test_prefetch_factory_guards_every_separate_metadata_request(self):
        session=self.prepare();self.runtime.prefetch=True
        await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual(self.runtime.dispatches[:3],["metadata:prm","metadata:asm","initialize"])
        metadata=[item for item in self.runtime.client_options if item["auth"] is None]
        self.assertEqual(len(metadata),1)
        self.assertFalse(metadata[0]["trust_env"])
        self.assertFalse(metadata[0]["follow_redirects"])

    async def test_revocation_inside_prefetch_cannot_admit_later_metadata_or_business_http(self):
        import asyncio
        session=self.prepare();self.runtime.prefetch=True;self.runtime.auth_phase="metadata:prm";live=True
        async def guard():
            if not live: raise RuntimeError("revoked")
        task=asyncio.create_task(session.call_tool("relay_submit",self.message,guard))
        await self.runtime.auth_started.wait();live=False;self.runtime.auth_release.set()
        with self.assertRaises(NativeSessionError):await task
        self.assertEqual(self.runtime.dispatches,[])
        self.assertEqual(self.runtime.attempts,[])

    async def test_unapproved_metadata_origin_is_denied_before_dispatch(self):
        session=self.prepare();self.runtime.prefetch=True;self.runtime.request_urls["metadata:prm"]="https://unapproved.example/.well-known/oauth"
        with self.assertRaises(NativeSessionError):await session.call_tool("relay_submit",self.message,self.guard)
        self.assertEqual(self.runtime.dispatches,[])

    async def test_metadata_only_exit_failure_is_terminal_even_when_main_stack_closes(self):
        session = self.prepare()
        self.runtime.prefetch = True
        original_exit = self.runtime.httpx.AsyncClient.__aexit__

        async def exit_client(client, *exc):
            if client.auth is None:
                raise OSError("PRIVATE_METADATA_CLEANUP_DETAIL")
            return await original_exit(client, *exc)

        with patch.object(self.runtime.httpx.AsyncClient, "__aexit__", exit_client):
            with self.assertRaisesRegex(NativeSessionUnsettled, "^native_cleanup_uncertain$"):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(self.runtime.dispatches, ["metadata:prm", "metadata:asm"])
        self.assertEqual(self.runtime.attempts, [])
        self.assertIn("transport.close", [event for event, _ in self.runtime.events])
        self.assertTrue(session._unsettled)
        with self.assertRaises(NativeSessionUnsettled):
            await session.aclose()
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 1)

    async def test_cancellation_during_metadata_only_exit_retains_unsettled_ownership(self):
        session = self.prepare()
        self.runtime.prefetch = True
        exiting, release = asyncio.Event(), asyncio.Event()
        original_exit = self.runtime.httpx.AsyncClient.__aexit__

        async def exit_client(client, *exc):
            if client.auth is None:
                exiting.set()
                await release.wait()
            return await original_exit(client, *exc)

        with patch.object(self.runtime.httpx.AsyncClient, "__aexit__", exit_client):
            pending = asyncio.create_task(session.call_tool("relay_submit", self.message, self.guard))
            await asyncio.wait_for(exiting.wait(), 1)
            self.assertFalse(pending.done())
            self.assertTrue(session._busy)
            with self.assertRaisesRegex(NativeSessionError, "^native_call_refused$"):
                await session.call_tool("relay_submit", self.message, self.guard)
            pending.cancel()
            with self.assertRaisesRegex(NativeSessionUnsettled, "^native_cleanup_uncertain$"):
                await pending
        self.assertTrue(session._unsettled)
        with self.assertRaises(NativeSessionUnsettled):
            await session.aclose()
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 1)
        self.assertEqual(self.runtime.dispatches, ["metadata:prm", "metadata:asm"])
        self.assertEqual(self.runtime.attempts, [])

    async def test_metadata_body_failure_with_proven_close_allows_a_fresh_operation(self):
        session = self.prepare()
        self.runtime.prefetch = True
        self.runtime.request_urls["metadata:prm"] = "https://unapproved.example/metadata"
        with self.assertRaises(NativeSessionError):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertFalse(session._unsettled)
        self.assertEqual([event for event, _ in self.runtime.events].count("transport.close"), 2)
        self.runtime.request_urls.clear()
        await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 2)
        self.assertEqual([name for name, _ in self.runtime.attempts], ["hab_discover", "relay_submit"])

    async def test_status_only_scope_never_accepts_submit_other_identity_or_reply(self):
        self.prepare()
        scope = NativeStatusScope(self.scope.agent_id, self.scope.as_address,
            self.scope.source_sender_id, self.scope.source_message_id, self.scope.message_ids)
        self.assertFalse(hasattr(scope, "thread_id"))
        session = HermesNativeSession(self.profile, "hab_relay", "https://relay.example/mcp",
            runtime=self.runtime.runtime, outbound_scope=scope)
        for name in ("relay_submit", "relay_poll", "relay_ack", "hab_register", "hab_discover"):
            with self.assertRaises(NativeSessionError):
                await session.call_tool(name, self.message, self.guard)
        args = {key:self.message[key] for key in ("message_id", "as_address", "expected_agent_id")}
        for key, value in (("message_id", "other"), ("as_address", "other@demo.hab"), ("expected_agent_id", "other")):
            with self.assertRaises(NativeSessionError):
                await session.call_tool("relay_status", {**args, key:value}, self.guard)
        self.assertEqual(self.runtime.provider_calls, [])
        await session.call_tool("relay_status", args, self.guard)
        self.assertEqual([name for name, _ in self.runtime.attempts], ["hab_discover", "relay_status"])
        for ids in (frozenset(), frozenset({"one", "two"}), frozenset({"*"})):
            with self.assertRaises(ValueError):
                NativeStatusScope("fake-agent", "worker@demo.hab", "fake-peer", "fake-source", ids)

    async def test_trusted_product_cleanup_class_is_terminal_after_auth_failure(self):
        session = self.prepare()
        class ProductCleanupUncertain(BaseException): pass
        base_runtime = self.runtime.runtime
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        async def negotiate(*_):
            raise ProductCleanupUncertain("PRIVATE_PRODUCT_CLEANUP_DETAIL")
        with patch.object(self.runtime.core.MCPServerTask, "_negotiate_session", negotiate):
            with self.assertRaisesRegex(NativeSessionUnsettled, "^native_cleanup_uncertain$"):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertTrue(session._unsettled)
        self.assertEqual(self.runtime.attempts, [])
        self.assertIn("transport.close", [event for event, _ in self.runtime.events])
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 1)

    async def test_trusted_product_cleanup_class_after_rpc_never_replays_or_reuses(self):
        session = self.prepare()
        class ProductCleanupUncertain(BaseException): pass
        base_runtime = self.runtime.runtime
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        original = self.runtime.core.ClientSession.call_tool
        async def rpc(client, name, **kwargs):
            value = await original(client, name, **kwargs)
            if name == "relay_submit": raise ProductCleanupUncertain()
            return value
        with patch.object(self.runtime.core.ClientSession, "call_tool", rpc):
            with self.assertRaises(NativeSessionUnsettled):
                await session.call_tool("relay_submit", self.message, self.guard)
        with self.assertRaises(NativeSessionUnsettled): await session.aclose()
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual([name for name, _ in self.runtime.attempts], ["hab_discover", "relay_submit"])
        self.assertEqual(len(self.runtime.provider_calls), 1)

    async def test_error_message_or_flag_is_not_a_trusted_cleanup_class(self):
        session = self.prepare()
        class OrdinaryFailure(Exception):
            cleanup_uncertain = True
        base_runtime = self.runtime.runtime
        class ProductCleanupUncertain(BaseException): pass
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        async def negotiate(*_): raise OrdinaryFailure("OAuthOperationCleanupError")
        with patch.object(self.runtime.core.MCPServerTask, "_negotiate_session", negotiate):
            with self.assertRaises(NativeSessionError):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertFalse(session._unsettled)
        await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 2)

    @unittest.skipIf(ExceptionGroupType is None, "standard exception groups require Python 3.11+")
    async def test_nested_mixed_cancel_auth_group_preserves_trusted_cleanup_uncertainty(self):
        session = self.prepare()
        class ProductCleanupUncertain(BaseException): pass
        base_runtime = self.runtime.runtime
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        async def negotiate(*_):
            raise ExceptionGroupType("synthetic auth group", [
                RuntimeError("ordinary"), asyncio.CancelledError(),
                ExceptionGroupType("nested", [ProductCleanupUncertain()])])
        with patch.object(self.runtime.core.MCPServerTask, "_negotiate_session", negotiate):
            with self.assertRaisesRegex(NativeSessionUnsettled, "^native_cleanup_uncertain$"):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertTrue(session._unsettled)
        self.assertEqual(self.runtime.attempts, [])
        self.assertIn("transport.close", [event for event, _ in self.runtime.events])
        with self.assertRaises(NativeSessionUnsettled): await session.aclose()
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 1)

    @unittest.skipIf(ExceptionGroupType is None, "standard exception groups require Python 3.11+")
    async def test_rpc_task_group_with_trusted_cleanup_leaf_never_replays(self):
        session = self.prepare()
        class ProductCleanupUncertain(BaseException): pass
        base_runtime = self.runtime.runtime
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        original = self.runtime.core.ClientSession.call_tool
        async def rpc(client, name, **kwargs):
            value = await original(client, name, **kwargs)
            if name == "relay_submit":
                raise ExceptionGroupType("synthetic rpc group", [ProductCleanupUncertain()])
            return value
        with patch.object(self.runtime.core.ClientSession, "call_tool", rpc):
            with self.assertRaises(NativeSessionUnsettled):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertTrue(session._unsettled)
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual([name for name, _ in self.runtime.attempts], ["hab_discover", "relay_submit"])
        self.assertEqual(len(self.runtime.provider_calls), 1)

    @unittest.skipIf(ExceptionGroupType is None, "standard exception groups require Python 3.11+")
    async def test_native_unsettled_leaf_in_standard_group_needs_no_product_class(self):
        session = self.prepare()
        async def negotiate(*_):
            raise ExceptionGroupType("synthetic native group", [
                ExceptionGroupType("nested", [NativeSessionUnsettled("native_cleanup_uncertain")])])
        with patch.object(self.runtime.core.MCPServerTask, "_negotiate_session", negotiate):
            with self.assertRaises(NativeSessionUnsettled):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertTrue(session._unsettled)
        with self.assertRaises(NativeSessionUnsettled):
            await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 1)

    @unittest.skipIf(ExceptionGroupType is None, "standard exception groups require Python 3.11+")
    async def test_nonmatching_cancel_group_with_proven_close_is_reusable(self):
        session = self.prepare()
        class ProductCleanupUncertain(BaseException): pass
        # Same-looking names/attributes and non-group .exceptions do not classify.
        Lookalike = type("ProductCleanupUncertain", (RuntimeError,), {
            "cleanup_uncertain":True, "exceptions":(ProductCleanupUncertain(),)})
        base_runtime = self.runtime.runtime
        session._runtime = lambda: (*base_runtime(), (ProductCleanupUncertain,))
        async def negotiate(*_):
            raise ExceptionGroupType("synthetic cancelled body", [
                asyncio.CancelledError(), ExceptionGroupType("ordinary nested group", [Lookalike()])])
        with patch.object(self.runtime.core.MCPServerTask, "_negotiate_session", negotiate):
            with self.assertRaisesRegex(NativeSessionError, "^native_call_failed$"):
                await session.call_tool("relay_submit", self.message, self.guard)
        self.assertFalse(session._unsettled)
        await session.call_tool("relay_submit", self.message, self.guard)
        self.assertEqual(len(self.runtime.provider_calls), 2)
