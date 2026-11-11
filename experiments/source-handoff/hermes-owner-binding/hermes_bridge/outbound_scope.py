"""Private local outbound policy and official authenticated whoami validation.

Policy values are permission, not authentication. Only the product-owned TLS/MCP
session may supply the whoami response. Never expose this module as a proof API.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re


def _id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value) is not None


@dataclass(frozen=True)
class NativeStatusScope:
    """Read-only reconciliation for an exact journaled reply; no thread is invented."""
    agent_id: str
    as_address: str
    source_sender_id: str
    source_message_id: str
    message_ids: frozenset[str]

    def __post_init__(self):
        if (not all(_id(v) for v in (self.agent_id, self.source_sender_id, self.source_message_id))
            or not isinstance(self.as_address, str)
            or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\.hab", self.as_address) is None
            or type(self.message_ids) is not frozenset or len(self.message_ids) != 1
            or not all(_id(v) for v in self.message_ids)):
            raise ValueError("native_outbound_policy_invalid")

    def arguments(self, name, args):
        if (name != "relay_status" or not isinstance(args, dict)
            or set(args) != {"message_id", "as_address", "expected_agent_id"}
            or args.get("message_id") not in self.message_ids
            or args.get("as_address") != self.as_address or args.get("expected_agent_id") != self.agent_id):
            raise ValueError("native_outbound_refused")
        return dict(args)


@dataclass(frozen=True)
class NativeOutboundScope:
    agent_id: str
    as_address: str
    source_sender_id: str
    source_message_id: str
    thread_id: str
    message_ids: frozenset[str]

    def __post_init__(self):
        if (not all(_id(v) for v in (self.agent_id, self.source_sender_id, self.source_message_id, self.thread_id))
            or not isinstance(self.as_address, str)
            or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\.hab", self.as_address) is None
            or type(self.message_ids) is not frozenset or not 1 <= len(self.message_ids) <= 100
            or not all(_id(v) for v in self.message_ids)):
            raise ValueError("native_outbound_policy_invalid")

    def arguments(self, name, args):
        """Constrain routing again in the native child; no caller-selected identity."""
        if not isinstance(args, dict) or name not in ("relay_submit", "relay_status"):
            raise ValueError("native_outbound_refused")
        if args.get("as_address") != self.as_address or args.get("expected_agent_id") != self.agent_id:
            raise ValueError("native_outbound_refused")
        if args.get("message_id") not in self.message_ids:
            raise ValueError("native_outbound_refused")
        if name == "relay_status":
            if set(args) != {"message_id", "as_address", "expected_agent_id"}:
                raise ValueError("native_outbound_refused")
        elif (set(args) != {"version", "message_id", "recipient_id", "kind", "body", "thread_id", "in_reply_to", "first_sent_at", "expires_at", "as_address", "expected_agent_id"}
              or type(args.get("version")) is not int or args["version"] != 1
              or args.get("kind") != "answer" or args.get("recipient_id") != self.source_sender_id
              or args.get("thread_id") != self.thread_id
              or args.get("in_reply_to") != {"sender_id":self.source_sender_id, "message_id":self.source_message_id}):
            raise ValueError("native_outbound_refused")
        # Take a bounded immutable-by-copy snapshot before the first await.
        raw = json.dumps(args, ensure_ascii=False, allow_nan=False)
        if len(raw.encode()) > 65536:
            raise ValueError("native_outbound_refused")
        return json.loads(raw)


def assignment(result, scope, operation):
    """Validate official whoami within the native authenticated session, not tool input."""
    raw = result.model_dump_json(by_alias=True, exclude_none=True)
    if not isinstance(raw, str) or len(raw.encode()) > 65536:
        raise ValueError("native_identity_unverified")
    value = json.loads(raw)
    content = value.get("content")
    if (value.get("isError") is True or not isinstance(content, list) or len(content) != 1
        or set(content[0]) != {"type", "text"} or content[0]["type"] != "text"):
        raise ValueError("native_identity_unverified")
    who = json.loads(content[0]["text"])
    if not isinstance(who, dict) or who != value.get("structuredContent"):
        raise ValueError("native_identity_unverified")
    selected, connection = who.get("selected_identity"), who.get("connection")
    if (type(who.get("version")) is not int or who.get("version") != 1 or who.get("source") != "hab_registry"
        or who.get("selection_basis") != "requested_group_name"
        or not isinstance(selected, dict) or not isinstance(connection, dict)
        or selected.get("agent_id") != scope.agent_id or selected.get("address") != scope.as_address
        or selected.get("registration_state") != "active"
        or not isinstance(selected.get("authorized_operations"), list)
        or not all(isinstance(op,str) and op in ("submit","status","poll","ack","resolve") for op in selected["authorized_operations"])
        or operation.removeprefix("relay_") not in selected["authorized_operations"]
        or set(connection) != {"kind", "id", "binding_id"}
        or not all(_id(connection.get(k)) for k in ("id", "binding_id"))):
        raise ValueError("native_identity_unverified")
    owner = selected.get("authentication_assignment")
    if (connection["kind"] not in ("individual_connection", "authentication_group")
        or owner != {"kind":connection["kind"], "id":connection["id"], "binding_state":"active"}):
        raise ValueError("native_identity_unverified")
    observed = datetime.fromisoformat(who.get("observed_at", "").replace("Z", "+00:00"))
    if observed.tzinfo is None or abs((datetime.now(timezone.utc) - observed).total_seconds()) > 60:
        raise ValueError("native_identity_unverified")
    # host_identity is deliberately NOT used: remote OAuth assignment is not
    # authentication of the local native session or permission to grant its tools.
    return (connection["kind"], connection["id"], connection["binding_id"], scope.agent_id, scope.as_address)
