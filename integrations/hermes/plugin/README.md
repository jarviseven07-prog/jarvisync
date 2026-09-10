# JarviSync for Hermes

This is a native Hermes plugin. It adds a small instruction block to every
new Hermes session and sends lifecycle receipts to the JarviSync local runtime.
It also supplies the installer template for Hermes's stdio MCP connection.

The installer copies this directory to `%HERMES_HOME%/plugins/jarvisync-hermes`,
then places the shared `runtime/` directory and a generated
`runtime/connection.json` in that same root. The connection file selects the
approved Nodeboard instance and includes the installer-selected persistent
`stateDir` and `nodeExecutable`. This adapter does not infer a default data
directory, port, or board instance.

The runtime paths are always absolute from the installed package root:

```text
<plugin-root>/runtime/mcp.mjs
<plugin-root>/runtime/hook.mjs
<plugin-root>/runtime/connection.json
```

## Hermes configuration merge contract

The installer owns user configuration writes and must preserve unrelated
entries. It adds this exact plugin key to `plugins.enabled`, removes the same
key from `plugins.disabled` if present, and writes one MCP entry:

```yaml
plugins:
  enabled:
    - jarvisync-hermes

mcp_servers:
  jarvisync:
    command: node
    args:
      - <absolute-plugin-root>/runtime/mcp.mjs
    enabled: true
    connect_timeout: 15
    tools:
      resources: false
      prompts: false
```

`mcp-server.template.json` is the same MCP entry in an installer-friendly
shape. Hermes itself reads `mcp_servers.jarvisync`; it does not load that
template automatically.

The supported interactive equivalent is:

```text
hermes plugins enable jarvisync-hermes
hermes mcp add jarvisync --command node --args <absolute-plugin-root>/runtime/mcp.mjs
```

The second command probes the server and asks the user to choose tools, so an
installer should perform its reviewed merge rather than impersonate that
interactive flow.

The current `hermes plugins install` command accepts a catalog name, Git URL,
or owner/repo reference, not a normal local package directory. For a locally
generated JarviSync package, copy it to the target plugin directory and run
`hermes plugins enable jarvisync-hermes`. In an isolated profile, set
`HERMES_HOME` to that profile root before running either command; Hermes gives
that environment value priority over its normal home directory.

## Lifecycle contract

The plugin invokes the generated absolute `nodeExecutable` from
`runtime/connection.json` for `<plugin-root>/runtime/hook.mjs --config
<plugin-root>/runtime/connection.json --host hermes` with one JSON object on
stdin. It reads that generated connection file once per receipt for the stable
profile identity and allowlisted string `runtimeEnv` values such as
`ELECTRON_RUN_AS_NODE`; it never depends on a Node executable found on the
new user's PATH. It never sends the raw user message, conversation history,
child goal, tool output, or secrets.

| Hermes callback | JarviSync event | Meaning |
| --- | --- | --- |
| `on_session_start` | `SessionStart` | A new session exists, with Hermes's actual callback model when supplied. |
| `pre_llm_call` with a host turn ID | `UserPromptSubmit` | A user turn is about to run; its only returned text supplies the current exact `sessionId` for MCP requests. When Hermes has no turn ID, it injects the ID but does not write a repeatable turn receipt. |
| `on_session_end` with `interrupted` | `Interrupt` | The turn was stopped or superseded. |
| other `on_session_end` outcomes | `Stop` | A turn ended; `completed` only means a final response, not a business delivery. |
| `subagent_start` | `SubagentStart` | Supplies the real child identity; task scope is unavailable until the parent explicitly passes the assigned node. |
| `subagent_stop` | `Stop` with `source: subagent` | Child exit status only, under the child's own identity. |

`on_session_finalize` is intentionally not forwarded: it is a session
teardown/reset boundary, not work completion. The adapter never calls a
JarviSync delivery operation from a lifecycle callback.

Hermes's native system-prompt section is frozen when a session starts. For an
explicit work request, it directs the model to use Hermes tool search when MCP
tools are deferred, then use JarviSync discovery, attach/context/start before
making a deliverable and deliver after the real result exists. The small
per-turn `pre_llm_call` prompt repeats that complete, conditional sequence with
the current exact `sessionId`, so it stays actionable even when the frozen
section has been diluted by a long session. Normal questions and no-record
requests skip the sequence. It does not splice dynamic board content into the
prompt.
