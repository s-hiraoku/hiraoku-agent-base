"""Synthetic-only adapter protocol checks. No Hermes process, credentials, or real inbox."""
import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("hab_test_backend", Path(__file__).parents[1] / "dashboard/hab_backend.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


@pytest.fixture
def harness(tmp_path):
    config = {"binding_id": "binding", "stored_session_id": "session", "connection_id": "connection",
              "profile": "test", "backend_namespace": "backend", "profile_scope": "test", "receiver_id": "recipient",
              "command": ["/fixture/node", "/fixture/hab-notify.ts", "--config", "/fixture/notify.json"], "cwd": "/fixture"}
    config["destination_binding"] = {"product": "hermes-desktop", "session_id": "session", "recipient_id": "recipient",
                                     "profile": "test", "connection_id": '["https://hab.example/mcp","backend","test"]'}
    path = tmp_path / "plugins/hab-desktop-adapter/config.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    calls = []
    response = {"state": "shown", "revision": 1, "choices": [{"choice": "accept", "label": "Handle"}, {"choice": "later", "label": "Later"}]}
    event = {"binding_id": "binding", "stored_session_id": "session", "backend_namespace": "backend",
             "profile_scope": "test", "receiver_id": "recipient", "sender_id": "sender", "message_id": "message",
             "source": "external_agent", "format": "plain_text", "text": "synthetic", "event_id": "event",
             "address": "sender@example.hab", "owner_kind": "session", "received_at": "2026-01-01T00:00:00Z",
             "binding_generation": 1, "logical_target": "session", "handoff_state": "pending"}

    async def run(config, home, verb, payload=None, args=()):
        calls.append((verb, payload))
        if verb == "binding": return {"binding_id": "binding", "destination_binding": config["destination_binding"]}
        if verb == "events": return {"source": "external_agent", "events": [event], "next_cursor": "next", "has_more": False}
        if verb == "states": return {"binding_id": "binding", "scope": "requested", "keys": payload["keys"],
                                     "states": [{**key, **response} for key in payload["keys"]]}
        if verb == "adapter-action": return {"binding_id": "binding", "scope": "requested", "keys": [{k: payload[k] for k in ("sender_id", "message_id")}], "changed": True, "state": "queued", "revision": 2}
        raise AssertionError(verb)

    return mod.Adapter(tmp_path, lambda sid: sid == "session", run), config, path, calls, response, event


def request(config, **extra):
    return {**{k: config[k] for k in mod.IDENTITY}, **extra}


def test_common_state_and_action_no_notifier_or_agent_launch(harness):
    a, c, _, calls, _, _ = harness
    result = asyncio.run(a.query("session", request(c)))
    assert result["decision_states"][0]["choices"][1]["choice"] == "later"
    assert not any(verb == "adapter-action" for verb, _ in calls)
    assert asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="accept")))["state"] == "queued"
    assert [v for v, _ in calls] == ["binding", "events", "states", "binding", "states", "adapter-action"]


@pytest.mark.parametrize("field", mod.IDENTITY)
def test_hostile_scope_never_calls_command(harness, field):
    a, c, _, calls, _, _ = harness
    with pytest.raises(mod.Unavailable):
        asyncio.run(a.query("session", request(c, **{field: "foreign"})))
    assert calls == []


def test_missing_session_never_calls_command(harness):
    a, c, _, calls, _, _ = harness
    a.session_exists = lambda sid: False
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))
    assert not calls


@pytest.mark.parametrize("state", ["queued", "unknown", "accept_waiting", "showing"])
def test_nonactionable_state_no_handoff(harness, state):
    a, c, _, calls, row, _ = harness
    row["state"] = state
    with pytest.raises(mod.Unavailable):
        asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="accept")))
    assert all(v != "adapter-action" for v, _ in calls)


def test_reply_choices_prevent_decline(harness):
    a, c, _, calls, _, _ = harness
    with pytest.raises(mod.Unavailable):
        asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="decline")))
    assert all(v != "adapter-action" for v, _ in calls)


def test_config_switch_during_read_rejects_stale_result(harness):
    a, c, path, calls, _, _ = harness
    old = a.run
    async def switched(config, home, verb, payload=None, args=()):
        result = await old(config, home, verb, payload, args)
        if verb == "events": path.write_text(json.dumps({**c, "profile": "new"}))
        return result
    a.run = switched
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))


def test_session_removed_during_state_lookup_prevents_handoff(harness):
    a, c, _, calls, _, _ = harness
    old = a.run
    async def removed(config, home, verb, payload=None, args=()):
        result = await old(config, home, verb, payload, args)
        if verb == "states": a.session_exists = lambda sid: False
        return result
    a.run = removed
    with pytest.raises(mod.Unavailable):
        asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="accept")))
    assert all(v != "adapter-action" for v, _ in calls)


@pytest.mark.parametrize("bad", ["binding_id", "stored_session_id", "profile_scope"])
def test_foreign_event_never_becomes_visible(harness, bad):
    a, c, _, _, _, event = harness
    event[bad] = "other"
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))


def test_private_config_permissions_required(harness):
    a, c, path, calls, _, _ = harness
    path.chmod(0o644)
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))
    assert not calls


def test_actual_destination_mismatch_rejects_before_events(harness):
    a, c, _, calls, _, _ = harness
    old = a.run
    async def mismatch(config, home, verb, payload=None, args=()):
        result = await old(config, home, verb, payload, args)
        if verb == "binding": result["destination_binding"] = {**result["destination_binding"], "session_id": "other"}
        return result
    a.run = mismatch
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))
    assert [v for v, _ in calls] == ["binding"]


@pytest.mark.parametrize("problem", ["missing", "foreign", "echo", "failure"])
def test_preflight_fail_closed(harness, problem):
    a, c, _, calls, _, _ = harness
    old = a.run
    async def broken(config, home, verb, payload=None, args=()):
        result = await old(config, home, verb, payload, args)
        if verb == "states":
            if problem == "missing": result["states"] = []
            if problem == "foreign": result["states"][0]["message_id"] = "other"
            if problem == "echo": result["keys"] = []
            if problem == "failure": raise OSError("synthetic private diagnostic")
        return result
    a.run = broken
    with pytest.raises((mod.Unavailable, OSError)):
        asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="accept")))
    assert all(v != "adapter-action" for v, _ in calls)


def test_query_strips_unrecognized_envelope_fields(harness):
    a, c, _, _, row, event = harness
    event["raw_envelope"] = "private"
    row["raw_record"] = "private"
    result = asyncio.run(a.query("session", request(c)))
    assert "raw_envelope" not in result["events"][0]
    assert "raw_record" not in result["decision_states"][0]


def test_runtime_router_redacts_failures(monkeypatch):
    api_spec = importlib.util.spec_from_file_location("hab_test_api", Path(__file__).parents[1] / "dashboard/plugin_api.py")
    api = importlib.util.module_from_spec(api_spec)
    api_spec.loader.exec_module(api)
    class Broken:
        async def binding(self): raise ValueError("private command output")
    monkeypatch.setattr(api, "adapter", lambda: Broken())
    with pytest.raises(api.HTTPException) as error: asyncio.run(api.binding())
    assert error.value.status_code == 503
    assert error.value.detail == "HAB adapter is unavailable"


@pytest.mark.parametrize("field,value", [("session_id", "other"), ("profile", "other"), ("product", "other")])
def test_decide_rejects_actual_destination_even_with_valid_opaque_binding(harness, field, value):
    a, c, _, calls, _, _ = harness
    old = a.run
    async def mismatch(config, home, verb, payload=None, args=()):
        result = await old(config, home, verb, payload, args)
        if verb == "binding": result["destination_binding"] = {**result["destination_binding"], field: value}
        return result
    a.run = mismatch
    with pytest.raises(mod.Unavailable):
        asyncio.run(a.decide("session", request(c, sender_id="sender", message_id="message", choice="accept")))
    assert [v for v, _ in calls] == ["binding"]


@pytest.mark.parametrize("text", ["a" * 131072, "\x01" * 131072])
def test_one_maximum_size_notice_fits_bounded_page_and_advances(harness, text):
    a, c, _, _, _, event = harness
    event["text"] = text
    old = a.run
    observed = []
    async def page(config, home, verb, payload=None, args=()):
        if verb == "events":
            observed.append(args)
            if args[:2] == ["--limit", "50"]:
                raise mod.Unavailable("response_too_large")
            assert args[:2] == ["--limit", "1"]
        result = await old(config, home, verb, payload, args)
        assert len(mod.compact(result).encode()) < mod.MAX_BYTES
        return result
    a.run = page
    result = asyncio.run(a.query("session", request(c, after="previous")))
    assert result["events"][0]["text"] == text
    assert result["next_cursor"] == "next"
    assert observed == [["--limit", "50", "--after", "previous"],
                        ["--limit", "1", "--after", "previous"]]


def test_oversized_config_is_refused_before_unbounded_read(harness):
    a, c, path, calls, _, _ = harness
    path.write_bytes(b" " * 16001)
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))
    assert not calls


def test_config_symlink_is_refused(harness, tmp_path):
    a, c, path, calls, _, _ = harness
    target = tmp_path / "saved.json"
    path.rename(target)
    path.symlink_to(target)
    with pytest.raises(OSError): asyncio.run(a.query("session", request(c)))
    assert not calls



def test_escaped_keys_split_by_serialized_bytes_not_only_count(harness):
    a, c, _, _, _, _ = harness
    keys = [{"sender_id": "\x01" * 512, "message_id": "\x02" * 511 + str(i)} for i in range(2)]
    old = a.run
    batches = []
    async def observe(config, home, verb, payload=None, args=()):
        if verb == "states":
            batches.append(payload["keys"])
            assert len(mod.compact(payload["keys"]).encode()) <= 12000
        return await old(config, home, verb, payload, args)
    a.run = observe
    result = asyncio.run(a.query("session", request(c, retained_keys=keys)))
    assert len(result["decision_states"]) == 3
    assert len(batches) == 2
    assert not result["decision_error_keys"]


def test_read_timeout_kills_and_reaps_only_owned_child(monkeypatch):
    class Input:
        def close(self): pass
    class Output:
        async def read(self, size):
            await asyncio.sleep(10)
    class Process:
        stdin = Input()
        stdout = Output()
        returncode = None
        killed = False
        reaped = False
        def kill(self): self.killed = True; self.returncode = -9
        async def wait(self): self.reaped = True; return self.returncode
    process = Process()
    async def spawn(*args, **kwargs): return process
    monkeypatch.setattr(mod.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(mod, "READ_TIMEOUT", 0.01)
    with pytest.raises(TimeoutError):
        asyncio.run(mod.run_command({"command": ["/synthetic"], "cwd": "/tmp"}, Path("/tmp"), "states"))
    assert process.killed and process.reaped


def test_global_route_timeout_is_redacted_without_retry(monkeypatch):
    api_spec = importlib.util.spec_from_file_location("hab_timeout_api", Path(__file__).parents[1] / "dashboard/plugin_api.py")
    api = importlib.util.module_from_spec(api_spec)
    api_spec.loader.exec_module(api)
    calls = []
    class Slow:
        async def decide(self, *args):
            calls.append("action")
            await asyncio.sleep(10)
    monkeypatch.setattr(api, "adapter", lambda: Slow())
    monkeypatch.setattr(api, "ROUTE_TIMEOUT", 0.01)
    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.decision("session", {}))
    assert error.value.status_code == 503
    assert calls == ["action"]


def test_shared_frontend_backend_roundtrip_fixture(harness):
    """The controller consumes this same exact request/response fixture in Node tests."""
    fixture = json.loads((Path(__file__).parent / "fixtures/roundtrip.json").read_text())
    a, c, _, calls, row, _ = harness
    original = a.run

    async def common_hab(config, home, verb, payload=None, args=()):
        result = await original(config, home, verb, payload, args)
        if verb == "events" and "--after" in args:
            result["events"] = []
        if verb == "adapter-action":
            row.update(state="queued", revision=2)
        return result

    a.run = common_hab
    assert asyncio.run(a.binding()) == fixture["binding"]
    assert "after" not in fixture["operations"][0]["request"]
    for operation in fixture["operations"]:
        method = a.decide if operation["name"] == "decision" else a.query
        assert asyncio.run(method("session", operation["request"])) == operation["response"]
    choices = fixture["operations"][0]["response"]["decision_states"][0]["choices"]
    assert all(set(choice) == {"choice", "label"} for choice in choices)
    action_calls = [payload for verb, payload in calls if verb == "adapter-action"]
    assert action_calls == [{"binding_id": "binding", "sender_id": "sender", "message_id": "message", "choice": "accept"}]
    assert fixture["operations"][-1]["response"]["events"] == []
    assert fixture["operations"][-1]["response"]["decision_states"][0]["state"] == "queued"



def test_normal_page_retains_50_notice_throughput(harness):
    a, c, _, _, _, event = harness
    original = a.run
    reads = []
    async def normal(config, home, verb, payload=None, args=()):
        result = await original(config, home, verb, payload, args)
        if verb == "events":
            reads.append(args)
            result["events"] = [{**event, "event_id": f"e{i}", "message_id": f"m{i}"} for i in range(50)]
            result["has_more"] = True
        return result
    a.run = normal
    result = asyncio.run(a.query("session", request(c)))
    assert len(result["events"]) == len(result["decision_states"]) == 50
    assert result["has_more"] is True
    assert reads == [["--limit", "50"]]


@pytest.mark.parametrize("error", [mod.Unavailable("command_failed"), ValueError("bad_json"), OSError("io")])
def test_arbitrary_reader_failure_is_never_retried(harness, error):
    a, c, _, _, _, _ = harness
    original = a.run
    reads = []
    async def broken(config, home, verb, payload=None, args=()):
        if verb == "events":
            reads.append(args)
            raise error
        return await original(config, home, verb, payload, args)
    a.run = broken
    with pytest.raises(type(error)):
        asyncio.run(a.query("session", request(c, after="previous")))
    assert reads == [["--limit", "50", "--after", "previous"]]


def test_oversized_single_notice_fallback_has_exactly_two_attempts(harness):
    a, c, _, _, _, _ = harness
    original = a.run
    reads = []
    async def oversized(config, home, verb, payload=None, args=()):
        if verb == "events":
            reads.append(args)
            raise mod.Unavailable("response_too_large")
        return await original(config, home, verb, payload, args)
    a.run = oversized
    with pytest.raises(mod.Unavailable): asyncio.run(a.query("session", request(c)))
    assert reads == [["--limit", "50"], ["--limit", "1"]]
