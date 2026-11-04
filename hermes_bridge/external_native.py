"""Explicit in-process Hermes bindings. Importing never starts Hermes or a model."""

import threading

from hermes_bridge.external_contract import ExternalRequestError, bounded


def text_agent_class(agent_base):
    """Use the real AIAgent lifecycle, with a dispatch boundary that admits no tool."""

    class TextOnlyExternalAgent(agent_base):
        def assert_text_only(self):
            if self.tools or self.valid_tool_names:
                raise ExternalRequestError("native_tools_not_empty")
            if self._memory_store is not None or self._memory_manager is not None:
                raise ExternalRequestError("native_memory_enabled")
            if not self.skip_context_files or self.load_soul_identity:
                raise ExternalRequestError("native_context_not_isolated")
            if not self._skip_mcp_refresh or not self._persist_disabled:
                raise ExternalRequestError("native_refresh_or_history_enabled")
            for name, maximum in (
                ("max_iterations", 3),
                ("max_tokens", 4096),
                ("run_budget_seconds", 60),
            ):
                value = getattr(self, name, None)
                if type(value) not in (int, float) or not 0 < value <= maximum:
                    raise ExternalRequestError("native_budget_unbounded")
            if self._fallback_model is not None or self._fallback_chain:
                raise ExternalRequestError("native_fallback_enabled")

        def _execute_tool_calls(self, *args, **kwargs):
            # File, shell, plugin, browser, sub-agent, execute_code and MCP calls
            # all stop here BEFORE the ordinary dispatcher can cause a side effect.
            raise ExternalRequestError("external_tools_forbidden")

    return TextOnlyExternalAgent


class NativeTextRunner:
    """Own one explicitly constructed, isolated native agent for text drafting."""

    def __init__(self, agent, check_current):
        self.agent, self.check_current = agent, check_current
        agent.assert_text_only()
        self._lock = threading.Lock()

    def close(self):
        self.agent.close()

    def draft(self, request, execution_key):
        if not self._lock.acquire(blocking=False):
            raise ExternalRequestError("native_runner_busy")
        try:
            return self._draft(request, execution_key)
        finally:
            self._lock.release()

    def _draft(self, request, execution_key):
        self.check_current()
        self.agent.assert_text_only()
        result = self.agent.run_conversation(
            user_message=request.model_input(),
            conversation_history=None,
            task_id=execution_key,
            turn_author={
                "id": request.sender_id,
                "name": "External agent",
                "is_bot": True,
            },
        )
        self.check_current()
        self.agent.assert_text_only()
        if (
            not isinstance(result, dict)
            or result.get("interrupted")
            or result.get("failed")
            or result.get("partial")
            or result.get("completed") is not True
        ):
            raise ExternalRequestError("native_result_unverified")
        return bounded(result.get("final_response"), 8192)


class NativeOwnerApproval:
    """Attach durable reply approval to the existing native owner's Desktop controls.

    authority, principal and ref are host objects, never parsed from a HAB message.
    No RPC or HTTP endpoint is added. The native authority authenticates answers;
    this attachment also refuses a session with any non-owner subscriber.
    """

    def __init__(self, authority, principal, ref, generation, consumer):
        self.authority, self.principal, self.ref = authority, principal, ref
        self.generation, self.consumer = generation, consumer
        self.installed = set()
        self.check()

    def check(self):
        binding = self.consumer.binding
        if (
            self.principal.subject != binding.owner_id
            or self.principal.profile_id != binding.profile
        ):
            raise ExternalRequestError("recipient_owner_required")
        if self.ref.profile_id != binding.profile:
            raise ExternalRequestError("native_scope_mismatch")
        self.consumer.check_current()
        self.authority.authorize(self.principal, self.ref, "session:approve")
        self.authority.check_approval_generation(self.ref.session_id, self.generation)
        live = self.authority.sessions[self.ref.session_id]
        if any(
            p.subject != binding.owner_id or p.profile_id != binding.profile
            for p in live.subscribers.values()
        ):
            raise ExternalRequestError("recipient_owner_required")
        return live

    def publish(self, key):
        live = self.check()
        row, action = self.consumer.pending_reply(key)
        prompt_id = row["approval_id"]
        if prompt_id in self.installed:
            return prompt_id
        if prompt_id in live.controls.pending:
            raise ExternalRequestError("native_prompt_conflict")

        def answer(kind, received_id, choice):
            current = self.check()
            if (
                not current.subscribers
                or kind != "approval"
                or received_id != prompt_id
            ):
                raise ExternalRequestError("recipient_owner_required")
            self.consumer.owner_decision(key, prompt_id, row["approval_hash"], choice)

        live.controls.remote_responders[prompt_id] = answer
        try:
            live.controls.register(
                self.ref.session_id,
                None,
                self.generation,
                {
                    "request_id": prompt_id,
                    "command": action["text"],
                    "description": "Reply for Task "
                    + action["task_id"]
                    + " to external agent "
                    + action["recipient_id"],
                    "allow_session": False,
                    "allow_permanent": False,
                },
            )
        except BaseException:
            live.controls.remote_responders.pop(prompt_id, None)
            raise
        self.installed.add(prompt_id)
        return prompt_id

    async def respond(self, actor, prompt_id, choice):
        self.check()
        if (
            actor.subject != self.principal.subject
            or actor.profile_id != self.ref.profile_id
        ):
            raise ExternalRequestError("recipient_owner_required")
        return await self.authority.respond(
            actor, self.ref, self.generation, prompt_id, {"choice": choice}
        )


def load_native_text_runner(runtime, expected_home, expected_commit, check_current):
    """Explicit host composition using existing native runtime credentials, never discovery.

    Call only inside a dedicated approved Hermes process. No listener, daemon,
    credential creation or profile rewrite is performed by this factory.
    """
    import importlib.util
    import os
    from pathlib import Path
    import re
    import subprocess
    import sys

    if (
        os.environ.get("HERMES_DISABLE_LAZY_INSTALLS") != "1"
        or sys.prefix == sys.base_prefix
    ):
        raise ExternalRequestError("explicit_prepared_native_process_required")
    allowed = {"model", "provider", "api_mode", "base_url", "api_key", "cwd"}
    if (
        not isinstance(runtime, dict)
        or set(runtime) - allowed
        or not {"model", "provider", "cwd"} <= runtime.keys()
    ):
        raise ExternalRequestError("native_runtime_configuration_required")
    from agent.safe_worker_policy import safe_worker_enabled

    def native_check():
        check_current()
        if not safe_worker_enabled():
            raise ExternalRequestError("native_managed_text_worker_required")

    native_check()
    if not isinstance(expected_commit, str) or not re.fullmatch(
        r"[a-f0-9]{40}", expected_commit
    ):
        raise ExternalRequestError("reviewed_native_source_required")
    source = Path(importlib.util.find_spec("run_agent").origin).resolve().parent

    def check_source():
        commit = subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip()
        dirty = subprocess.check_output(
            ["git", "--no-optional-locks", "-C", str(source), "status", "--porcelain"],
            text=True,
            timeout=5,
        )
        if commit != expected_commit or dirty:
            raise ExternalRequestError("native_source_mismatch")

    check_source()
    from hermes_constants import get_hermes_home
    from hermes_cli.config_backend import read_config_doc_readonly

    if Path(expected_home).resolve() != get_hermes_home().resolve():
        raise ExternalRequestError("native_scope_mismatch")
    config = read_config_doc_readonly(Path(expected_home) / "config.yaml") or {}
    if (config.get("plugins") or {}).get("enabled") or (
        config.get("context") or {}
    ).get("engine"):
        raise ExternalRequestError("native_extension_scope_unverified")
    from run_agent import AIAgent

    agent = text_agent_class(AIAgent)(
        **runtime,
        enabled_toolsets=[],
        disabled_toolsets=[],
        max_iterations=3,
        max_tokens=4096,
        run_budget_seconds=60,
        quiet_mode=True,
        skip_context_files=True,
        load_soul_identity=False,
        skip_memory=True,
        skip_background_review=True,
        session_db=None,
        save_trajectories=False,
        fallback_model=None,
        checkpoints_enabled=False,
        platform="api_server",
    )
    agent._skip_mcp_refresh = True
    agent._persist_disabled = True
    try:

        def check_run():
            native_check()
            check_source()

        check_run()
        return NativeTextRunner(agent, check_run)
    except BaseException:
        agent.close()
        raise
