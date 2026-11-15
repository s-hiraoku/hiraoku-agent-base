"""Thin, profile-local transport for HAB's existing common notifier API.

No notifier, decision database, model process or session is created here.
"""
import asyncio
import hashlib
import json
import os
import re
import stat
from pathlib import Path

IDENTITY = ("binding_id", "stored_session_id", "connection_id", "profile")
EVENT_FIELDS = ("event_id", "source", "format", "sender_id", "receiver_id", "message_id",
                "address", "backend_namespace", "profile_scope", "owner_kind", "received_at", "text",
                "binding_id", "binding_generation", "logical_target", "stored_session_id", "handoff_state")
EVENT_SCOPE = ("backend_namespace", "profile_scope", "receiver_id")
MAX_BYTES = 2 * 1024 * 1024
READ_TIMEOUT = 8
ACTION_TIMEOUT = 40
CLEANUP_TIMEOUT = 2


class Unavailable(ValueError):
    """Redacted protocol/configuration failure."""


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def keys_checked(keys):
    if not isinstance(keys, list) or len(keys) > 50 or len(compact(keys).encode()) > 16000:
        raise Unavailable("invalid_keys")
    seen = set()
    for key in keys:
        if (not isinstance(key, dict) or set(key) != {"sender_id", "message_id"}
                or any(not isinstance(v, str) or not v or len(v.encode()) > 512 for v in key.values())):
            raise Unavailable("invalid_key")
        pair = (key["sender_id"], key["message_id"])
        if pair in seen:
            raise Unavailable("duplicate_key")
        seen.add(pair)
    return keys


def private_config(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Unavailable("private_config_required")
        if info.st_size > 16000:
            raise Unavailable("config_too_large")
        raw = source.read(16001)
    if len(raw) > 16000:
        raise Unavailable("config_too_large")
    value = json.loads(raw)
    fields = set(IDENTITY + EVENT_SCOPE) | {"command", "cwd", "destination_binding"}
    if not isinstance(value, dict) or set(value) != fields:
        raise Unavailable("invalid_config")
    if any(not isinstance(value[k], str) or not value[k] or len(value[k]) > 2048 for k in IDENTITY + EVENT_SCOPE):
        raise Unavailable("invalid_identity")
    destination = value["destination_binding"]
    if (not isinstance(destination, dict) or set(destination) != {"product", "connection_id", "recipient_id", "session_id", "profile"}
            or destination.get("product") != "hermes-desktop"
            or destination.get("session_id") != value["stored_session_id"]
            or destination.get("profile") != value["profile"]
            or destination.get("recipient_id") != value["receiver_id"]):
        raise Unavailable("invalid_destination")
    connection = json.loads(destination.get("connection_id", ""))
    if (not isinstance(connection, list) or len(connection) != 3
            or not isinstance(connection[0], str) or not connection[0]
            or connection[1:] != [value["backend_namespace"], value["profile_scope"]]):
        raise Unavailable("invalid_destination_connection")
    command = value["command"]
    if (not isinstance(command, list) or not 1 <= len(command) <= 32
            or any(not isinstance(arg, str) or not arg or len(arg) > 4096 or "\0" in arg for arg in command)
            or not Path(command[0]).is_absolute() or not Path(value["cwd"]).is_absolute()):
        raise Unavailable("invalid_command")
    return value, hashlib.sha256(raw).hexdigest()


async def run_command(config, home, verb, payload=None, args=()):
    """Only operator-configured HAB argv; no shell, Hermes executable or inherited credentials."""
    process = await asyncio.create_subprocess_exec(
        *config["command"], verb, *args, cwd=config["cwd"],
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "HERMES_HOME": str(home)},
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(ACTION_TIMEOUT if verb == "adapter-action" else READ_TIMEOUT):
            if payload is not None:
                process.stdin.write(compact(payload).encode())
                await process.stdin.drain()
            process.stdin.close()
            raw = bytearray()
            while chunk := await process.stdout.read(65536):
                raw.extend(chunk)
                if len(raw) > MAX_BYTES:
                    raise Unavailable("response_too_large")
            if await process.wait() != 0:
                raise Unavailable("command_failed")
        result = json.loads(raw)
        if not isinstance(result, dict) or "error" in result:
            raise Unavailable("command_failed")
        return result
    finally:
        if process.returncode is None:
            process.kill()
        await asyncio.wait_for(process.wait(), timeout=CLEANUP_TIMEOUT)


class Adapter:
    def __init__(self, home, session_exists, runner=run_command):
        self.home = Path(home)
        self.path = self.home / "plugins/hab-desktop-adapter/config.json"
        self.session_exists = session_exists
        self.run = runner

    def snapshot(self):
        config, stamp = private_config(self.path)
        if not self.session_exists(config["stored_session_id"]):
            raise Unavailable("session_unavailable")
        return config, stamp

    def unchanged(self, config, stamp):
        current, current_stamp = self.snapshot()
        if current_stamp != stamp or current != config:
            raise Unavailable("configuration_changed")

    async def verified(self, session=None, request=None):
        config, stamp = self.snapshot()
        if request is not None and (session != config["stored_session_id"] or any(
                request.get(k) != config[k] for k in IDENTITY)):
            raise Unavailable("binding_mismatch")
        binding = await self.run(config, self.home, "binding")
        if (binding.get("binding_id") != config["binding_id"]
                or binding.get("destination_binding") != config["destination_binding"]):
            raise Unavailable("binding_mismatch")
        self.unchanged(config, stamp)
        return config, stamp

    async def binding(self):
        config, _ = await self.verified()
        return {k: config[k] for k in IDENTITY + EVENT_SCOPE}

    async def states(self, config, keys):
        keys_checked(keys)
        result = await self.run(config, self.home, "states", {"binding_id": config["binding_id"], "keys": keys})
        if (result.get("binding_id") != config["binding_id"] or result.get("scope") != "requested"
                or result.get("keys") != keys or not isinstance(result.get("states"), list)):
            raise Unavailable("invalid_state_scope")
        found = {}
        requested = {(key["sender_id"], key["message_id"]) for key in keys}
        for row in result["states"]:
            if not isinstance(row, dict):
                raise Unavailable("invalid_state")
            pair = (row.get("sender_id"), row.get("message_id"))
            if (pair not in requested or pair in found or not isinstance(row.get("state"), str)
                    or not re.fullmatch(r"[a-z_]{1,32}", row["state"])
                    or type(row.get("revision")) is not int or not 0 <= row["revision"] <= 2**53 - 1):
                raise Unavailable("invalid_state")
            choices = row.get("choices")
            if (not isinstance(choices, list) or not 1 <= len(choices) <= 3
                    or any(not isinstance(c, dict) or set(c) != {"choice", "label"}
                           or c["choice"] not in ("accept", "later", "decline")
                           or not isinstance(c["label"], str) or not c["label"].strip()
                           or len(c["label"]) > 64 for c in choices)
                    or len({c["choice"] for c in choices}) != len(choices)):
                raise Unavailable("invalid_choices")
            found[pair] = {"binding_id": config["binding_id"], **{k: row[k] for k in ("sender_id", "message_id", "state", "revision", "choices")}}
        return found

    async def query(self, session, request):
        if not isinstance(request, dict) or set(request) - set(IDENTITY) - {"after", "retained_keys"}:
            raise Unavailable("invalid_request")
        retained = keys_checked(request.get("retained_keys", []))
        config, stamp = await self.verified(session, request)
        after = request.get("after")
        if after is not None and (not isinstance(after, str) or not after or len(after) > 2048):
            raise Unavailable("invalid_cursor")
        args = ["--limit", "1"] + (["--after", after] if after else [])
        page = await self.run(config, self.home, "events", args=args)
        events = page.get("events")
        if (page.get("source") != "external_agent" or not isinstance(events, list) or len(events) > 1
                or not isinstance(page.get("next_cursor"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,2048}", page["next_cursor"])
                or type(page.get("has_more")) is not bool):
            raise Unavailable("invalid_events")
        if (events or page["has_more"]) and page["next_cursor"] == after:
            raise Unavailable("nonadvancing_cursor")
        pairs = {(k["sender_id"], k["message_id"]) for k in retained}
        for event in events:
            if (not isinstance(event, dict) or event.get("binding_id") != config["binding_id"]
                    or event.get("stored_session_id") != session or any(event.get(k) != config[k] for k in EVENT_SCOPE)
                    or event.get("source") != "external_agent" or event.get("format") != "plain_text"
                    or not isinstance(event.get("text"), str) or len(event["text"].encode()) > 131072
                    or event.get("owner_kind") not in ("session", "bot") or event.get("handoff_state") != "pending"
                    or type(event.get("binding_generation")) is not int or not 1 <= event["binding_generation"] <= 2**53 - 1
                    or any(not isinstance(event.get(k), str) or not event[k] or len(event[k]) > 2048
                           for k in EVENT_FIELDS if k not in ("text", "binding_generation"))):
                raise Unavailable("invalid_event_binding")
            keys_checked([{k: event.get(k) for k in ("sender_id", "message_id")}])
            pairs.add((event["sender_id"], event["message_id"]))
        updates, checked, errors = [], [], []
        # Small batches bound escaped response size including choices and echoed keys.
        pairs = sorted(pairs)
        batches, batch = [], []
        for sender, message in pairs:
            key = {"sender_id": sender, "message_id": message}
            if batch and (len(batch) == 10 or len(compact([*batch, key]).encode()) > 12000):
                batches.append(batch)
                batch = []
            batch.append(key)
        if batch:
            batches.append(batch)
        for keys in batches:
            scoped = [{"binding_id": config["binding_id"], **key} for key in keys]
            try:
                states = await self.states(config, keys)
            except (OSError, ValueError, TypeError):
                errors.extend(scoped)
            else:
                updates.extend(states.values())
                checked.extend(scoped)
        self.unchanged(config, stamp)
        return {"source": "external_agent", "events": [{k: e[k] for k in EVENT_FIELDS} for e in events],
                "next_cursor": page["next_cursor"], "has_more": page["has_more"], "decision_states": updates, "decision_checked_keys": checked,
                "decision_error_keys": errors, "binding_id": config["binding_id"]}

    async def decide(self, session, request):
        fields = set(IDENTITY) | {"sender_id", "message_id", "choice"}
        if not isinstance(request, dict) or set(request) != fields or request.get("choice") not in ("accept", "later", "decline"):
            raise Unavailable("invalid_decision")
        key = {k: request[k] for k in ("sender_id", "message_id")}
        keys_checked([key])
        config, stamp = await self.verified(session, request)
        states = await self.states(config, [key])
        row = states.get((key["sender_id"], key["message_id"]))
        if row is None or row["state"] not in ("shown", "later") or request["choice"] not in {c["choice"] for c in row["choices"]}:
            raise Unavailable("decision_unavailable")
        self.unchanged(config, stamp)
        result = await self.run(config, self.home, "adapter-action", {
            "binding_id": config["binding_id"], **key, "choice": request["choice"]})
        self.unchanged(config, stamp)
        if (result.get("binding_id") != config["binding_id"] or result.get("scope") != "requested"
                or result.get("keys") != [key] or type(result.get("changed")) is not bool
                or not isinstance(result.get("state"), str) or not re.fullmatch(r"[a-z_]{1,32}", result["state"])
                or type(result.get("revision")) is not int or not 0 <= result["revision"] <= 2**53 - 1):
            raise Unavailable("invalid_action_result")
        return {k: result[k] for k in ("binding_id", "changed", "state", "revision")}
