"""JarviSync's Hermes host adapter.

The plugin deliberately only emits host lifecycle receipts.  It never creates
or completes a JarviSync work item by itself: a Hermes turn ending is not
evidence that the requested work was delivered.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
from pathlib import Path
from queue import Full, Queue
import re
import subprocess
import time
from datetime import datetime
from threading import Lock, Thread
from typing import Any


logger = logging.getLogger(__name__)
_ROOT = Path(__file__).resolve().parent
_HOOK = _ROOT / "runtime" / "hook.mjs"
_CONNECTION = _ROOT / "runtime" / "connection.json"
_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_EVENTS: Queue[tuple[list[str], bytes, dict[str, Any]]] = Queue(maxsize=128)
_WORKER_LOCK = Lock()
_WORKER_STARTED = False
_PROGRESS_CHECKS: dict[str, float] = {}
_PROGRESS_NOTICES: dict[str, tuple[str, float]] = {}
_PROGRESS_LOCK = Lock()


def _progress_notice(session_id: str, model: str = "") -> str:
    """Read only a fresh, confirmed cache; refresh asynchronously without a host turn event."""
    now = time.time()
    try:
        connection = json.loads(_CONNECTION.read_text(encoding="utf-8"))
        key = hashlib.sha256(f"hermes\0{connection['profileId']}\0{session_id}".encode()).hexdigest()
        state = json.loads((Path(connection['stateDir']) / "sessions" / f"{key}.json").read_text(encoding="utf-8"))
        binding = state.get('binding') or {}
        checkpoint = state.get('progressCheckpoint') or {}
        if (state.get('recordingDisabled') or state.get('explicitRecordingOverride') is False
                or state.get('interrupted') or binding.get('recording') is not True
                or binding.get('humanEndedAt')
                or not binding.get('runId')
                or (not state.get('connectionError') and (binding.get('runId') != checkpoint.get('runId')
                    or binding.get('nodeId') != checkpoint.get('nodeId')))):
            return ""
        with _PROGRESS_LOCK:
            refresh = now - _PROGRESS_CHECKS.get(session_id, 0) >= 60
            if refresh:
                _PROGRESS_CHECKS[session_id] = now
        if refresh:
            _emit("ProgressCheck", session_id=session_id, model=model)
        if state.get('connectionError'):
            return ""
        observed = datetime.fromisoformat(state['progressObservedAt'].replace('Z', '+00:00')).timestamp()
        if not 0 <= now - observed <= 120 or not checkpoint.get('reminderDue'):
            return ""
        reminder_key = f"{checkpoint['runId']}:{checkpoint['lastProgressAt']}"
        with _PROGRESS_LOCK:
            previous_key, previous_at = _PROGRESS_NOTICES.get(session_id, (None, 0))
            if previous_key == reminder_key or now - previous_at < 600:
                return ""
            _PROGRESS_NOTICES[session_id] = (reminder_key, now)
        return ("\nJarviSync progress check: this active run has no recent progress record. "
                "Check for a real diagnosis, implementation-to-validation transition, validation result, "
                "blocker, decision change, or handoff. Only when new facts exist, call jarvisync_progress "
                "with completed work, evidence, remaining work and next step. Do not invent progress, "
                "repeat unchanged updates, deliver automatically, restart, or continue a stopped turn.")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return ""

_SYSTEM_PROMPT = """\
JarviSync records explicit work. Normal, unconfirmed, and no-record requests create no records.

For explicit work, record unless the user says not to; use Hermes tool search to locate the tools, then JarviSync discovery and
attach/context/start in that order; take IDs only from responses. Create few nodes for independent deliverables. A later new
deliverable gets its own node, not old-node progress; without child-agent capability, complete nodes sequentially.

Planning a Codex node is not launching an external Codex process: launch only on the user's explicit
request. Start only after the host successfully dispatches work; Node ownership or a planned model
is not evidence of dispatch. On long work, record milestones, blockers, and next steps.

For fields: multiple goal or next items each use a real new line starting "- " or "1. "; separate
topics with a blank line, never a literal "\\n". Keep progress factual: completed and pending work
in separate paragraphs; state decisions separately. Preserve quoted user words; keep needed facts,
never full tool logs.

For failed sync, read context and its current revision, then resolve using the original failed
request ID: retry only identical business content, or discard without stopping work. Retry a lost
response unchanged; after 409, never change an old request's version. Respect a user redirect or
stop immediately; deliver only after the requested output exists and the result is recorded.

A Hermes turn end, stop event, interruption, or child-agent exit is host status only and is never proof of business completion.
"""


def _text(value: Any) -> str | None:
    """Keep the host envelope scalar and omit unavailable metadata."""
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _connection() -> tuple[str | None, str | None, dict[str, str]]:
    """Read only this generated connection file and expose non-secret launch fields."""
    try:
        value = json.loads(_CONNECTION.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
        return None, None, {}
    if not isinstance(value, dict):
        return None, None, {}
    executable = _text(value.get("nodeExecutable"))
    if executable is None or not Path(executable).is_absolute():
        return _text(value.get("profileId")), None, {}
    runtime_env = value.get("runtimeEnv")
    if not isinstance(runtime_env, dict):
        runtime_env = {}
    safe_env = {
        key: item
        for key, item in runtime_env.items()
        if isinstance(key, str) and isinstance(item, str) and _ENV_NAME.fullmatch(key)
    }
    return _text(value.get("profileId")), executable, safe_env


def _event_worker() -> None:
    """Run receipts in FIFO order and reap each child without blocking Hermes."""
    while True:
        command, payload, options = _EVENTS.get()
        try:
            subprocess.run(command, input=payload, timeout=15, **options)
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.debug("JarviSync lifecycle receipt failed: %s", exc)
        finally:
            _EVENTS.task_done()


def _enqueue(command: list[str], payload: dict[str, Any], options: dict[str, Any]) -> None:
    global _WORKER_STARTED
    with _WORKER_LOCK:
        if not _WORKER_STARTED:
            Thread(target=_event_worker, name="jarvisync-hermes-receipts", daemon=True).start()
            _WORKER_STARTED = True
    try:
        _EVENTS.put_nowait((command, json.dumps(payload, ensure_ascii=False).encode("utf-8"), options))
    except Full:
        logger.debug("JarviSync lifecycle receipt queue is full; dropping a host receipt")


def _emit(event: str, *, session_id: Any = None, model: Any = None,
          turn_id: Any = None, **metadata: Any) -> None:
    """Send a small, best-effort receipt to the shared Node runtime.

    The child owns stdin until it exits.  The callback does not wait for the
    local service or parse stdout, so a stopped/offline board cannot stall a
    Hermes model turn.  ``runtime/hook.mjs`` owns durable queuing and retries.
    """
    if not _HOOK.is_file():
        logger.debug("JarviSync runtime is absent at %s", _HOOK)
        return
    profile_id, node_executable, runtime_env = _connection()
    if node_executable is None:
        logger.debug("JarviSync runtime has no absolute generated node executable")
        return
    try:
        cwd = str(Path.cwd())
    except OSError:
        cwd = ""
    payload = {
        "host": "hermes",
        "hook_event_name": event,
        "cwd": cwd,
        "metadata": {key: value for key, value in metadata.items() if value is not None},
    }
    for key, value in (("session_id", _text(session_id)), ("profile_id", profile_id),
                       ("model", _text(model)), ("turn_id", _text(turn_id))):
        if value is not None:
            payload[key] = value
    for key in ("scope", "agent_scope", "task_scope", "completed", "failed", "interrupted", "source",
                "parent_session_id", "child_session_id", "agent_id", "agent_type"):
        if key in metadata and metadata[key] is not None:
            payload[key] = metadata[key]
    options: dict[str, Any] = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": str(_ROOT),
        "env": {**os.environ, **runtime_env},
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
    _enqueue([node_executable, str(_HOOK), "--config", str(_CONNECTION), "--host", "hermes"], payload, options)


def _on_session_start(session_id: str = "", model: str = "", platform: str = "", **_: Any) -> None:
    _emit("SessionStart", session_id=session_id, model=model, platform=_text(platform))


def _pre_llm_call(session_id: str = "", model: str = "", turn_id: str = "",
                  platform: str = "", task_id: str = "", **_: Any) -> str:
    # This is deliberately the only dynamic prompt text.  It carries the
    # current session identifier, which can change at a compression boundary;
    # it never carries user content or board context.
    binding = _text(session_id)
    if binding is None:
        return "JarviSync sessionId is unavailable for this turn. Do not call JarviSync MCP tools."
    # Hermes may call this hook for model iterations.  Only a supplied host turn
    # id is a durable turn receipt; a missing id must not reset lastTurn.
    if _text(turn_id) is not None:
        _emit("UserPromptSubmit", session_id=binding, model=model, turn_id=turn_id,
              platform=_text(platform), task_id=_text(task_id))
    return (
        "JarviSync protocol for an explicit user work request: this is required before "
        "you make the requested deliverable, unless the user said not to record. Use Hermes "
        "tool search and tool describe if the JarviSync MCP tools are deferred. Then call "
        "jarvisync_discover; if it reports no binding, call jarvisync_attach to create or associate "
        "the suitable project and node. For an existing binding, inspect it before associating the "
        "node for this independent deliverable. A previous binding does not make a new "
        "deliverable part of its old node: create a small number of nodes when needed, even if "
        "you must complete them sequentially because no child-agent capability is available. "
        "Arranging a Codex node is not permission to launch an external Codex process; launch "
        "one only if the user explicitly asks to start it. Then call jarvisync_context and jarvisync_start "
        "only after the host has actually dispatched this work successfully, "
        "using the host-provided actual model. Node ownership or a planned model is not evidence "
        "of dispatch. When a goal or next has multiple items, use real newline `- ` or `1. ` lines, keep progress factual with completed and pending work in separate paragraphs, and state decisions separately. Then record key milestones, blockers, and next steps with "
        "jarvisync_progress. If sync returns a failed or review-needed item, read context and "
        "verify its current revision, then use jarvisync_resolve with that failed request's "
        "clientOperationId, resolution retry or discard, and the current expectedRevision. Retry "
        "only identical business content; discard does not stop actual work. For a lost response, "
        "retry the original request unchanged; never change an old request's version after a 409. "
        "Respect a user redirect or stop immediately. Only after start, do the requested work. "
        "After the real output exists, call jarvisync_deliver with the returned nodeId, runId, "
        "current revision, a factual summary, and its artifact path. Do not stop after discovery "
        "or substitute a lifecycle receipt for these model actions. Questions and no-record "
        "requests skip this protocol. "
        f"JarviSync sessionId for this turn is `{binding}`. Pass this exact value to every JarviSync MCP request."
        + _progress_notice(binding, model)
    )


def _on_session_end(session_id: str = "", model: str = "", turn_id: str = "",
                    completed: bool = False, failed: bool = False, interrupted: bool = False,
                    turn_exit_reason: str = "", platform: str = "", task_id: str = "",
                    **_: Any) -> None:
    if interrupted:
        _emit("Interrupt", session_id=session_id, model=model, turn_id=turn_id,
              platform=_text(platform), task_id=_text(task_id), completed=bool(completed),
              failed=bool(failed), interrupted=True, turn_exit_reason=_text(turn_exit_reason))
        return
    _emit("Stop", session_id=session_id, model=model, turn_id=turn_id,
          platform=_text(platform), task_id=_text(task_id), completed=bool(completed),
          failed=bool(failed), interrupted=False, turn_exit_reason=_text(turn_exit_reason))


def _subagent_start(parent_session_id: str = "", parent_turn_id: str = "",
                    child_session_id: str = "", child_subagent_id: str = "",
                    child_role: str = "", **_: Any) -> None:
    # ``child_goal`` is intentionally not forwarded.  The bridge only needs a
    # stable child scope; the model records task context through MCP when needed.
    child = _text(child_session_id)
    _emit("SubagentStart", session_id=child, turn_id=parent_turn_id,
          parent_session_id=_text(parent_session_id), child_session_id=child,
          agent_id=_text(child_subagent_id), agent_type=_text(child_role),
          child_subagent_id=_text(child_subagent_id), child_role=_text(child_role))


def _subagent_stop(parent_session_id: str = "", parent_turn_id: str = "",
                   child_session_id: str = "", child_role: str = "",
                   child_status: str = "", duration_ms: Any = None, **_: Any) -> None:
    # The shared event vocabulary has no separate child-stop value.  Its scope
    # and status prevent the runtime from treating it as a parent delivery.
    child = _text(child_session_id)
    _emit("Stop", session_id=child, turn_id=parent_turn_id,
          parent_session_id=_text(parent_session_id), child_session_id=child,
          agent_type=_text(child_role), child_role=_text(child_role),
          child_status=_text(child_status), duration_ms=duration_ms,
          source="subagent")


def register(ctx: Any) -> None:
    """Register a frozen new-session instruction and observer-only lifecycle hooks."""
    ctx.register_system_prompt_section("jarvisync.onboarding", _SYSTEM_PROMPT, max_chars=1600)
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("subagent_start", _subagent_start)
    ctx.register_hook("subagent_stop", _subagent_stop)
