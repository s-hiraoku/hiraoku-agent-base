"""Opt-in API compatibility proof against a pinned Hermes checkout, never a model run."""

import argparse
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import MethodType, SimpleNamespace as NS

from hermes_bridge.external_contract import (
    ExternalRequestError,
    ExternalText,
    RecipientBinding,
)
from hermes_bridge.external_consumer import ExternalTextConsumer
from hermes_bridge.external_journal import NativeJournal
from hermes_bridge.external_native import (
    NativeOwnerApproval,
    load_native_text_runner,
    text_agent_class,
)


@contextmanager
def isolated_home(home):
    old = dict(os.environ)
    try:
        for key in list(os.environ):
            if any(
                s in key.upper()
                for s in ("TOKEN", "API_KEY", "SECRET", "PASSWORD", "AUTHORIZATION")
            ):
                os.environ.pop(key)
        os.environ["HERMES_HOME"] = str(home)
        os.environ["HERMES_RUNTIME_DIR"] = str(home / "runtime")
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        yield
    finally:
        os.environ.clear()
        os.environ.update(old)


def prove(source, expected_commit):
    source = Path(source)
    if not source.is_absolute() or source.resolve() != source:
        raise ExternalRequestError("explicit_hermes_source_required")
    commit = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != expected_commit:
        raise ExternalRequestError("native_source_mismatch")
    with tempfile.TemporaryDirectory(prefix="hermes-external-proof-") as raw:
        home = Path(raw).resolve()
        (home / "config.yaml").write_text(
            json.dumps(
                {"security": {"allow_lazy_installs": False}, "plugins": {"enabled": []}}
            )
        )
        with isolated_home(home):
            sys.path.insert(0, str(source))
            from gateway.session_authority import SessionAuthority
            from gateway.session_contract import Principal, SessionRef
            from gateway.session_pending_controls import PendingControls
            from run_agent import AIAgent

            # The adapter must refuse a normal process before client/model construction.
            try:
                load_native_text_runner(
                    {"model": "fixture", "provider": "fixture", "cwd": str(home)},
                    home,
                    expected_commit,
                    lambda: None,
                )
            except ExternalRequestError as error:
                if str(error) != "native_managed_text_worker_required":
                    raise
            else:
                raise AssertionError("unmanaged native process admitted")

            # Construction is intentionally bypassed: no client, credentials,
            # provider resolution, model, tool installation or real session starts.
            guarded_agent_class = text_agent_class(AIAgent)
            for tool in (
                "write_file",
                "terminal",
                "execute_code",
                "delegate_task",
                "plugin",
                "relay_submit",
            ):
                try:
                    guarded_agent_class._execute_tool_calls(None, tool, [], "proof")
                except ExternalRequestError as error:
                    if str(error) != "external_tools_forbidden":
                        raise
                else:
                    raise AssertionError("native dispatch unexpectedly allowed")

            binding = RecipientBinding(
                "fixture", "fixture-profile", "recipient", "recipient-owner", "epoch"
            )
            owner = Principal(
                "recipient-owner",
                "fixture-profile",
                frozenset({"session:approve"}),
                "owner-transport",
            )
            ref = SessionRef("fixture-profile", "local-fixture")
            events = NS(lock=threading.RLock(), frames=[])
            events.publish = lambda sid, payload, **kw: events.frames.append(
                (sid, payload, kw)
            )
            live = NS(
                controls=PendingControls(events),
                subscribers={"owner": owner},
                event_stream=events,
            )
            authority = NS(sessions={ref.session_id: live})

            def authorize(actor, target, capability):
                if (
                    actor != owner
                    or target != ref
                    or capability not in actor.capabilities
                ):
                    raise ExternalRequestError("native_permission_denied")

            def generation(sid, value):
                if sid != ref.session_id or value != 3:
                    raise ExternalRequestError("stale_generation")

            authority.authorize = authorize
            authority.check_approval_generation = generation
            authority.respond = MethodType(SessionAuthority.respond, authority)
            with_store = NativeJournal(home / "native.sqlite", binding)
            try:
                model = NS(draft=lambda request, key: "Synthetic draft; no model ran")
                consumer = ExternalTextConsumer(
                    with_store, model, lambda: None, lambda: 10
                )
                request = ExternalText(
                    "origin-owner-scope",
                    "sender",
                    "recipient",
                    "message",
                    "task",
                    "context",
                    "test data",
                    1000,
                )
                key = consumer.prepare(request)["key"]
                consumer.run_once(key)
                consumer.request_reply_approval(key, 100)
                gate = NativeOwnerApproval(authority, owner, ref, 3, consumer)
                prompt = gate.publish(key)
                snapshot = live.controls.snapshot(ref.session_id, 3)
                assert snapshot[0]["choices"] == ["once", "deny"]
                result = asyncio.run(gate.respond(owner, prompt, "once"))
                assert result["status"] == "resolved"
                assert with_store.get(key)["state"] == "reply_approved"
                assert len(events.frames) == 2
            finally:
                with_store.close()
    return {
        "hermes_commit": commit,
        "real_native_agent_dispatch_blocked": True,
        "real_pending_controls_and_authority_response_api": True,
        "authority_identity_and_model": "synthetic_fixture",
        "model_started": False,
        "live_ui_tested": False,
        "production_config_changed": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", required=True)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    print(json.dumps(prove(args.hermes_source, args.expected_commit), sort_keys=True))


if __name__ == "__main__":
    main()
