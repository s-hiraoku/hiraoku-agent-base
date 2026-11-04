"""Finite, opt-in native text processing. No poll, ACK, daemon or network sender."""

import json

from hermes_bridge.external_contract import ExternalRequestError, ExternalText, digest


class ExternalTextConsumer:
    def __init__(self, journal, model, check_current, clock):
        self.journal, self.model = journal, model
        self.binding = journal.binding
        self.check_current, self.clock = check_current, clock
        self.check_current()

    def prepare(self, request):
        self.check_current()
        return self.journal.prepare(request, self.clock())

    def run_once(self, key):
        self.check_current()
        row = self.journal.get(key)
        if row["state"] != "prepared":
            return row  # In particular, unknown is NEVER an automatic retry.
        request = ExternalText(**json.loads(row["request"]))
        if request.work_deadline <= self.clock():
            return self.journal.transition(key, "prepared", "rejected")
        # Persist the admission marker BEFORE model/provider work. A lost response
        # or restart leaves unknown, not another model invocation.
        self.journal.transition(key, "prepared", "running")
        try:
            result = self.model.draft(request, key)
            self.check_current()
            from hermes_bridge.external_contract import bounded

            bounded(result, 8192)
        except Exception:
            return self.journal.transition(key, "running", "unknown")
        return self.journal.transition(key, "running", "result_ready", result=result)

    def request_reply_approval(self, key, deadline):
        self.check_current()
        row = self.journal.get(key)
        work_deadline = json.loads(row["request"])["work_deadline"]
        if type(deadline) is not int or not self.clock() < deadline <= work_deadline:
            raise ExternalRequestError("invalid_approval_deadline")
        return self.journal.propose_reply(key, deadline)

    def pending_reply(self, key):
        self.check_current()
        row = self.journal.get(key)
        if row["state"] != "awaiting_owner":
            raise ExternalRequestError("native_state_conflict")
        return row, self._action(row)

    @staticmethod
    def _action(row):
        request = json.loads(row["request"])
        action = {
            "operation": "reply",
            "recipient_id": request["sender_id"],
            "in_reply_to": request["message_id"],
            "task_id": request["task_id"],
            "text": row["result"],
        }
        if digest(action) != row["approval_hash"]:
            raise ExternalRequestError("native_approval_conflict")
        return action

    def owner_decision(self, key, approval_id, action_hash, choice):
        # Host-only port: call only from NativeOwnerApproval after the native
        # authority authenticates the recipient owner. Never expose it on HAB.
        self.check_current()
        self._action(self.journal.get(key))
        return self.journal.decide(key, approval_id, action_hash, choice, self.clock())

    def handoff_reply(self, key, enqueue):
        """Hand off to the common layer's durable, idempotent outbox; never send here."""
        self.check_current()
        row = self.journal.get(key)
        if row["state"] != "reply_approved" or row["approval_deadline"] <= self.clock():
            raise ExternalRequestError("native_approval_expired_or_missing")
        action = self._action(row)
        self.journal.handoff(key)  # Consumption persists before the external callback.
        try:
            self.check_current()
            receipt = enqueue(row["approval_id"], action)
            self.check_current()
            if not isinstance(receipt, dict) or receipt != {
                "durable": True,
                "id": row["approval_id"],
            }:
                raise ExternalRequestError("outbox_receipt_unverified")
        except Exception:
            return self.journal.transition(key, "handoff_started", "unknown")
        return self.journal.transition(key, "handoff_started", "completed")

    def reconcile(self, key, inspect):
        """Owner-authorized reconciliation only. Never reruns a model or resends."""
        self.check_current()
        row = self.journal.get(key)
        if row["state"] != "unknown":
            raise ExternalRequestError("native_state_conflict")
        if row["consumed"] and row["approval_id"]:
            receipt = inspect(row["approval_id"])
            if receipt == {"durable": True, "id": row["approval_id"]}:
                return self.journal.transition(key, "unknown", "completed")
        return row

    def snapshot(self, key):
        """No owner identity, prompt ID, approval URL or private diagnostic in remote status."""
        self.check_current()
        row = self.journal.get(key)
        request = json.loads(row["request"])
        state = row["state"]
        return {
            "execution_key": key,
            "task_id": request["task_id"],
            "state": state,
            "wait_reason": "recipient_owner_approval"
            if state == "awaiting_owner"
            else None,
            "result": row["result"] if state == "completed" else None,
        }
