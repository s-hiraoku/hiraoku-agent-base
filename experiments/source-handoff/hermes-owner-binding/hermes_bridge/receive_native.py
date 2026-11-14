"""Hermes native OAuth + MCP session, receive by default; explicit private outbound scope. No model or token copy.

Imports of installed Hermes/SDK are lazy so fixtures need no installed profile.
The guard runs at the HTTP transport boundary, after OAuth/refresh waits.
"""

from contextlib import AsyncExitStack, asynccontextmanager
import asyncio
import builtins
from pathlib import Path
from urllib.parse import urlsplit


TOOLS = frozenset(
    ("hab_resolve", "hab_submit", "hab_status", "hab_poll", "hab_ack")
)

# hab_peek, hab_mark_read: the arrival notifier's tools (ADR-021); this receiver never calls them.
OPTIONAL_TOOLS = frozenset(("hab_discover", "hab_register", "hab_peek", "hab_mark_read"))
TASK_TOOLS = frozenset(("hab_task_send", "hab_task_get", "hab_task_list", "hab_task_cancel"))


def compatible_catalog(names):
    """Allow only the complete HAB tool contract plus known opt-in extensions."""
    if isinstance(names, (str, bytes)):
        return False
    try:
        values = list(names)
        if any(not isinstance(name, str) for name in values):
            return False
        catalog = set(values)
    except TypeError:
        return False
    return (
        len(values) == len(catalog)
        and TOOLS <= catalog
        and catalog <= TOOLS | OPTIONAL_TOOLS | TASK_TOOLS
        and (not catalog & TASK_TOOLS or TASK_TOOLS <= catalog)
    )


class NativeSessionError(Exception):
    pass


class NativeSessionUnsettled(BaseException):
    """The owned peer must exit; do not report uncertain native work as settled."""


_exception_group = getattr(builtins, "BaseExceptionGroup", None)


def _has_unsettled_leaf(error, terminal_classes):
    """Inspect only real standard task groups and trusted cleanup leaf classes."""
    pending = [error]
    while pending:
        current = pending.pop()
        if isinstance(current, (NativeSessionUnsettled, *terminal_classes)):
            return True
        if _exception_group is not None and isinstance(current, _exception_group):
            # Use the standard descriptor, not a lookalike .exceptions attribute.
            pending.extend(_exception_group.exceptions.__get__(current))
    return False


def _runtime():
    # Installed tools/mcp_oauth_manager.py _prefetch_oauth_metadata creates a
    # separate httpx.AsyncClient, outside the guarded transport below. Its public
    # manager API has no transport injection. Until a reviewed product-owned hook
    # guards that path too, refuse BEFORE native imports/config/provider/credential
    # access. Test fixtures inject only synthetic runtimes; no approval flag can
    # turn this unsupported real runtime into a verified integration.
    raise NativeSessionError("native_oauth_transport_guard_unavailable")


class HermesNativeSession:
    """One foreground owner; SDK contexts settle per RPC without replaying calls."""

    def __init__(self, profile, server_name, resource_url, *, runtime=_runtime, outbound_scope=None, oauth_origins=frozenset()):
        self.profile = Path(profile)
        self.server_name = server_name
        self.resource_url = resource_url
        self._runtime = runtime
        def origin(value):
            parsed = urlsplit(value)
            if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.scheme not in ("http", "https") or (parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "::1"))):
                raise NativeSessionError("native_origin_invalid")
            return (parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        if type(oauth_origins) is not frozenset or len(oauth_origins) > 8:
            raise NativeSessionError("native_origin_invalid")
        self._origins = frozenset([origin(resource_url)] + [origin(value) for value in oauth_origins])
        self._stack = None
        self._session = None
        self._guard = None
        self._busy = False
        self._owner = None
        self._unsettled = False
        self._terminal_cleanup_errors = ()
        self._outbound_scope = outbound_scope
        self._tools = ("hab_poll", "hab_ack")
        self._assignment = None
        self._identity_lost = False
        if outbound_scope is not None:
            from hermes_bridge.outbound_scope import NativeOutboundScope, NativeStatusScope
            if type(outbound_scope) not in (NativeOutboundScope, NativeStatusScope):
                raise NativeSessionError("native_outbound_policy_invalid")
            self._tools = (("hab_status",) if type(outbound_scope) is NativeStatusScope
                else ("hab_poll", "hab_ack", "hab_submit", "hab_status"))

    async def _check(self):
        if self._guard is None:
            raise NativeSessionError("native_guard_unavailable")
        await self._guard()

    async def _connect(self):
        if self._runtime is _runtime:
            _runtime()  # unsupported production path fails before any native import
        from hermes_constants import get_hermes_home
        # The official OAuth manager keys its provider by this exact native home.
        # Refuse a profile/config argument that would read another manager's cache.
        if not self.profile.is_absolute() or Path(get_hermes_home()).resolve() != self.profile:
            raise NativeSessionError("native_profile_mismatch")
        from hermes_cli.config_backend import read_config_doc_readonly

        raw = read_config_doc_readonly(self.profile / "config.yaml") or {}
        cfg = raw.get("mcp_servers", {}).get(self.server_name)
        if (
            not isinstance(cfg, dict)
            or cfg.get("url") != self.resource_url
            or cfg.get("auth") != "oauth"
            or cfg.get("ssl_verify", True) is not True
            or cfg.get("transport", "http")
            not in ("http", "streamable_http", "streamable-http")
            or cfg.get("tools", {}).get("exclude")
            or cfg.get("headers")
            or not compatible_catalog(cfg.get("tools", {}).get("include", []))
        ):
            raise NativeSessionError("native_config_mismatch")
        runtime = self._runtime()
        if not isinstance(runtime, tuple) or len(runtime) not in (4, 5):
            raise NativeSessionError("native_runtime_unsupported")
        core, suppress, manager, body_cap = runtime[:4]
        terminal = runtime[4] if len(runtime) == 5 else ()
        # Only the trusted pinned runtime supplies product exception classes.
        # JSON, RPC output and arbitrary error flags cannot mark or clear settlement.
        if (type(terminal) is not tuple or any(not isinstance(cls, type)
                or not issubclass(cls, BaseException) or issubclass(cls, Exception)
                or cls is BaseException for cls in terminal)):
            raise NativeSessionError("native_runtime_unsupported")
        self._terminal_cleanup_errors = terminal
        httpx = core.sdk_httpx()
        owner = self

        class GuardedTransport(httpx.AsyncBaseTransport):
            def __init__(self):
                self.inner = body_cap(httpx, httpx.AsyncHTTPTransport(retries=0))

            async def handle_async_request(self, request):
                # httpx calls the transport after its auth flow, including a refresh.
                await owner._check()
                url = urlsplit(str(request.url))
                destination = (url.scheme, url.hostname, url.port or (443 if url.scheme == "https" else 80))
                if url.username or url.password or destination not in owner._origins:
                    raise NativeSessionError("native_origin_refused")
                return await self.inner.handle_async_request(request)

            async def aclose(self):
                await self.inner.aclose()

        @asynccontextmanager
        async def metadata_client_factory():
            # This hook exists only in the separately reviewed product source copy.
            # It covers provider-owned prefetch as well as the outer auth-flow HTTP.
            await owner._check()
            metadata_stack = AsyncExitStack()
            try:
                client = await metadata_stack.enter_async_context(httpx.AsyncClient(
                    auth=None, transport=GuardedTransport(), follow_redirects=False,
                    trust_env=False, timeout=httpx.Timeout(10.0, read=10.0)))
                yield client
            finally:
                # This client is not part of the main SDK stack. Its own cleanup
                # must settle before that stack can prove the operation settled.
                # Preserve uncertainty even when later main-stack cleanup succeeds.
                try:
                    await metadata_stack.aclose()
                except BaseException:
                    owner._unsettled = True
                    raise NativeSessionUnsettled("native_cleanup_uncertain") from None
            await owner._check()

        stack = AsyncExitStack()
        try:
            stack.enter_context(suppress())
            auth = manager().get_or_build_provider(
                self.server_name, self.resource_url, cfg.get("oauth"),
                metadata_client_factory=metadata_client_factory,
            )
            if auth is None:
                raise NativeSessionError("native_oauth_unavailable")
            client = await stack.enter_async_context(
                httpx.AsyncClient(
                    auth=auth,
                    transport=GuardedTransport(),
                    follow_redirects=False,
                    trust_env=False,
                    timeout=httpx.Timeout(20.0, read=20.0),
                    headers={"MCP-Protocol-Version": core.LATEST_HANDSHAKE_VERSION},
                )
            )
            streams = await stack.enter_async_context(
                core.streamable_http_client(self.resource_url, http_client=client)
            )
            session = await stack.enter_async_context(
                core.ClientSession(streams[0], streams[1])
            )
            task = core.MCPServerTask(self.server_name)
            task._config = cfg
            await task._negotiate_session(session, 20.0)
            tools = await session.list_tools()
            names = [tool.name for tool in tools.tools]
            if not compatible_catalog(names) or (self._outbound_scope is not None and "hab_discover" not in names):
                raise NativeSessionError("native_catalog_mismatch")
            self._stack, self._session = stack, session
            self._owner = asyncio.current_task()
        except BaseException as error:
            if _has_unsettled_leaf(error, self._terminal_cleanup_errors):
                self._unsettled = True
            try:
                await stack.aclose()
            except BaseException:
                self._unsettled = True
                raise NativeSessionUnsettled("native_cleanup_uncertain") from None
            raise

    async def call_tool(self, name, args, guard):
        if self._identity_lost:
            raise NativeSessionError("native_identity_lost")
        if self._unsettled:
            raise NativeSessionUnsettled("native_cleanup_uncertain")
        if (
            (self._owner is not None and self._owner is not asyncio.current_task())
            or name not in self._tools
            or self._busy
        ):
            raise NativeSessionError("native_call_refused")
        if name in ("hab_submit", "hab_status"):
            try:
                args = self._outbound_scope.arguments(name, args)
            except Exception:
                raise NativeSessionError("native_call_refused") from None
        self._busy = True
        self._guard = guard
        try:
            await self._check()
            if self._session is None:
                await self._connect()
            if name in ("hab_submit", "hab_status"):
                from hermes_bridge.outbound_scope import assignment
                scope = self._outbound_scope
                await self._check()
                identity = await self._session.call_tool("hab_discover", arguments={
                    "action": "whoami", "as_address": scope.as_address,
                    "expected_agent_id": scope.agent_id})
                await self._check()
                try:
                    current = assignment(identity, scope, name)
                    if self._assignment is not None and current != self._assignment:
                        raise NativeSessionError("native_identity_changed")
                    self._assignment = current
                except Exception:
                    self._identity_lost = True
                    raise NativeSessionError("native_identity_lost") from None
            # No recoverer/replay loop: the durable host owns ACK/submit reconciliation.
            result = await self._session.call_tool(name, arguments=args)
            await self._check()
            encoded = result.model_dump_json(by_alias=True, exclude_none=True)
            # SDK call_tool may publish a result before HTTP/body cleanup settles.
            # Close the same-task SDK context before declaring the IPC request done.
            # The native OAuth manager/store is reused; the business RPC is never replayed.
            await self.aclose()
            await self._check()
            return encoded
        except BaseException as error:
            if _has_unsettled_leaf(error, self._terminal_cleanup_errors):
                self._unsettled = True
            if self._unsettled:
                # Best-effort close remaining same-task SDK contexts without ever
                # clearing the product/metadata uncertainty latch.
                await self._close_owned_stack()
                raise NativeSessionUnsettled("native_cleanup_uncertain") from None
            await self.aclose()
            raise NativeSessionError("native_call_failed") from None
        finally:
            self._guard = None
            self._busy = False

    async def aclose(self):
        if self._unsettled:
            raise NativeSessionUnsettled("native_cleanup_uncertain")
        await self._close_owned_stack()

    async def _close_owned_stack(self):
        if self._owner is not None and self._owner is not asyncio.current_task():
            raise NativeSessionError("native_owner_task_mismatch")
        self._owner = None
        stack, self._stack = self._stack, None
        self._session = None
        if stack is not None:
            was_unsettled = self._unsettled
            self._unsettled = True
            try:
                await stack.aclose()
            except BaseException:
                raise NativeSessionUnsettled("native_cleanup_uncertain") from None
            self._unsettled = was_unsettled


def runtime_capabilities():
    """Import/shape check only; no OAuth provider, account, connection, or database."""
    core, *_ = _runtime()
    needed = ("streamable_http_client", "sdk_httpx", "MCPServerTask", "ClientSession")
    if any(not callable(getattr(core, key, None)) for key in needed):
        raise NativeSessionError("native_runtime_unsupported")
    if not callable(getattr(core.MCPServerTask, "_negotiate_session", None)):
        raise NativeSessionError("native_runtime_unsupported")
    return {"version": 1, "native_mcp": True, "model_called": False}
