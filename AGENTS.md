# Working on JarviSync

Conventions for agents (and people) contributing to this repository.

## Product scope

JarviSync serves exactly five things: project nodes, context, progress, results
and hand-off. Do not invent work to fill in forms, to prove a process was
followed, or to reuse a module that does not fit. If a change does not make one
of those five things clearer, it probably does not belong here.

## Local first

The web UI and agents read and write the same data through a local server that
binds to localhost only. No database, no cloud, no telemetry, and neither
browsing nor agent reads/writes ever call a model.

Context is scoped: by default an agent reads its current project, its current
node, and directly related nodes. Detailed material stays behind links and is
read on demand rather than pasted into context.

## Before you change code

Read the current relevant source first. Preserve existing modifications and user
data — never overwrite on a guess. Do not auto-commit, publish, or send messages.
Verify what this particular change touches; do not re-run checks that already
passed for unrelated reasons. The most recent human instruction wins.

## The honest-reporting rule

This is the one convention that shapes the product itself, so it also applies to
the code:

- `start` / `stop` record receipts. The actual starting and stopping is done by
  the host. **A signature is not evidence that something ran.**
- Status reflects what an agent wrote back, never a liveness check. Do not add
  polling, heartbeats or "online" indicators.
- Keep the distinction between a human's own words, an agent's transcription of
  them, and an agent's response. One must never be able to impersonate another.
- When the host does not expose the real model, record the absence
  (`model: null`, `modelSource: 'host-unavailable'`) rather than guessing or
  inheriting from a plan or a previous run.

## Writes and conflicts

Every write carries the revision it read. On a `409`, re-read the context, check
what actually changed, then either retry the same business content or discard
the failed request — never hand an old request ID new content or a new revision.
Reuse the original request ID when a response is lost. Treat global revision
conflicts conservatively.

Test data and collaboration rehearsals must use a separate data directory.

## Write-back formatting

Content written into nodes is read by humans:

- When a goal or next step has several items, put each on its own line with a
  real newline and `- ` or `1. `. Separate topics with a blank line. Never write
  a literal `\n`.
- Progress is split into done and pending, and states facts only. Decisions get
  their own line.
- Keep human wording intact. Do not omit necessary information, and do not paste
  whole tool logs.
- A single simple sentence can stay a single sentence.

## Tests

```bash
npm test
npm run build
```

Both must pass before a change is considered done.
