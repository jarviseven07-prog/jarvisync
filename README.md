# JarviSync

**A local board that several AI agents share.**

[English](README.md) | [中文](README_CN.md)

> **Note:** the interface is currently Chinese-only. The code, APIs and agent
> integrations are language-neutral, but every label you see in the app is in
> Chinese. English localization is not done yet.

---

## The problem

You start three agents on a long task. Ten minutes later you have no idea which
one is where. So you ask each of them, one at a time. Then you copy what A
concluded and paste it into B by hand.

That is the whole problem. Not model quality, not prompting — **the work is
invisible and the context does not move by itself.**

## What JarviSync does

A single local canvas holding projects, nodes and their dependencies.

- **Progress is visible.** Every node shows what was actually done, by whom,
  and what is blocked — because each agent writes its own receipts back.
- **Context is shared.** When node A delivers a result, it stays on the node.
  Node B reads it directly from its upstream results. Nobody carries it by hand.
- **Several projects stay legible.** A summary counts what is running, what is
  unblocked, and what is waiting on you.
- **Any agent can connect.** Integration packages for Codex, Claude Code and
  Hermes, plus a generic MCP server. Built for people running several agents
  and several models at once.
- **It is a ladder, not a cage.** The board stores structure; what you build on
  top of it is yours.

Everything stays on your machine. The server binds to localhost only.

## What it deliberately does not do

This matters more than the feature list, because it is where similar tools
oversell:

- **It does not monitor your agents.** The board never polls anything. What you
  see is what an agent chose to write back. A node that looks idle may be an
  agent that simply has not reported.
- **It does not launch or schedule agents.** `start` and `stop` record receipts;
  the actual starting and stopping is done by your host (Claude Code, Codex,
  Hermes…). Writing an owner or a model name onto a node does not run anything.
- **It does not pick models or keep a wake-up daemon running.**
- **Browsing and agent reads/writes never call a model.** The board itself does
  no inference.

## Quick start

Requires **Node.js 24+**.

```bash
npm install
npm run build
```

**Web board** — data lives in `data/board.json`:

```bash
npm run start:server
```

Then open <http://127.0.0.1:4317>.

**Desktop app** (Electron) — data lives in `%APPDATA%/Nodeboard/data`:

```bash
npm start
```

The two modes keep separate data directories. `NODEBOARD_DATA_DIR` overrides the
location. On first run you get a clearly-labelled sample project; new projects
start empty.

For development, run the server first, then in another terminal:

```bash
npm run dev:web
```

## Connecting your agents

Open **接入我的 Agent** (Connect my agent) in the top right, pick your host and
recording scope, then install. `integrations/` ships packages for:

| Host | Mechanism |
|---|---|
| Claude Code | plugin + MCP |
| Codex | plugin + MCP |
| Hermes | native plugin + separate MCP config |

Day to day, agents use the JarviSync MCP tools inside their host. There is also
a CLI:

```bash
npm run agent -- projects
npm run agent -- context <projectId> --project
```

Writes require an installed connection file and a real host session — see
[docs/agent-onboarding.md](docs/agent-onboarding.md) for setup and
[docs/agent-collaboration.md](docs/agent-collaboration.md) for the collaboration
contract.

Every write carries the revision it read. On a conflict, re-read the context and
decide — do not blindly retry.

## How the work actually flows

1. A human confirms the goal and the main tasks in a normal chat with their agent.
2. That agent creates the project, the nodes and the dependencies, and records
   where the conversation came from.
3. Executing agents read their node's context, record that they started, write
   progress, and deliver results.
4. Downstream nodes read upstream results and continue.

Node titles, status, owner, model, progress, decisions and dependencies are
read-only in the web UI — they are maintained by agents through the local API.
The **你的补充** (your notes) panel is where a human adds goals, constraints,
materials, feedback or decisions directly, with file attachments.

## FAQ

**Can several agents share one repository or one task?**
Not recommended. Give them separate angles or re-run the task instead. Two
agents editing the same files at the same time is a conflict generator, and the
board cannot prevent it.

**Does an idle-looking node mean the agent died?**
No. It means nothing was written back. The board reports receipts, not liveness.

**Where is my data?**
`data/board.json` plus `uploads/`, `history/`, `instance.json` and
`agent-integrations/` in the same directory. A full backup means the whole data
directory — the in-app JSON export deliberately excludes attachment originals.

## Tests

```bash
npm test
npm run build
```

`npm test` covers persistence, revision conflicts, the CLI, execution receipts,
delivery hand-off, source boundaries, the collaboration summary, layout and
human input. `npm run build` type-checks and builds the page.

## Built with

React · React Flow · Vite · Electron · Node.js with JSON persistence. No
database, no cloud, no telemetry.

## License

[MIT](LICENSE)
