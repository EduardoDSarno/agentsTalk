# Agent Hub

A small shared server for a team of AI agents working on one repo. It provides:

- **File locks**: an agent locks a file before editing it, so other agents don't change the same file at the same time.
- **Shared task board**: everyone can see who is doing what.
- **Messages** between agents, sent to one teammate or to `all`.
- **Live dashboard**: every lock, task change and message shows up as it happens.

Any agent that supports MCP over HTTP can connect: Claude Code, Cursor, Codex, Windsurf, VS Code Copilot and others. Claude Code also gets a **hook** that enforces locks automatically.

## 1. Start the hub (one teammate's laptop)

```bash
npm install
AGENT_HUB_TOKEN=pick-a-secret npm start
```

Find that laptop's address on the Wi-Fi (macOS):

```bash
ipconfig getifaddr en0
```

Everyone opens the dashboard at `http://<that-ip>:4000/?token=pick-a-secret`.

The token is optional, but use it on shared hackathon Wi-Fi so strangers can't connect.

## 2. Connect each agent

Every person picks a unique name (e.g. `ana`). In the examples below, replace `HUB` with `http://<that-ip>:4000`.

### Claude Code: MCP tools + automatic locks

Add the MCP tools:

```bash
claude mcp add --transport http agent-hub "HUB/mcp?agent=ana&token=pick-a-secret"
```

Commit `hook.mjs` into your hackathon repo at `.agent-hub/hook.mjs`, then add this to the repo's `.claude/settings.json`, which can be committed and shared:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }]
  }
}
```

Each person puts their own name in `.claude/settings.local.json`, which is not committed:

```json
{ "env": { "AGENT_HUB_URL": "HUB", "AGENT_HUB_NAME": "ana", "AGENT_HUB_TOKEN": "pick-a-secret" } }
```

The hook then does the following:
- **Before every file edit**, it locks the file. If a teammate holds the lock, the edit is blocked and Claude is told who has the file.
- **At session start and on every prompt**, Claude gets the team status, including any new messages.
- If the hub is down, the hook lets work continue instead of blocking everyone.

### Cursor

In `.cursor/mcp.json`:

```json
{ "mcpServers": { "agent-hub": { "url": "HUB/mcp?agent=ana&token=pick-a-secret" } } }
```

### Codex CLI

In `~/.codex/config.toml`, if your version supports URL servers:

```toml
[mcp_servers.agent-hub]
url = "HUB/mcp?agent=ana&token=pick-a-secret"
```

### Any other agent

Use the same MCP URL with its HTTP MCP setting. With no MCP support, use the plain API:

```bash
curl "HUB/api/status?agent=ana&token=pick-a-secret"
curl -X POST "HUB/api/lock?agent=ana&token=pick-a-secret" -d '{"paths":["src/api.ts"],"reason":"adding search"}'
curl -X POST "HUB/api/unlock?agent=ana&token=pick-a-secret" -d '{}'
```

## 3. Tell non-Claude agents the rules

Only Claude Code gets the automatic lock check. Other agents follow the rules only if you tell them, so paste this into your repo's `AGENTS.md`, which Cursor, Codex and others read:

```md
## Team coordination (agent-hub MCP)
- Call the `status` tool at the start and before each new piece of work.
- Call `lock_files` with repo-relative paths BEFORE editing any file.
  If a file comes back BLOCKED, don't edit it: do other work or `send_message` the owner.
- Use `update_task` to set your task to `doing` when you start and `done` when it's merged.
- After you commit and push, call `unlock_files`.
- Use `log` to say what you're doing when you start something big.
```

## Tools agents get

| Tool | What it does |
|---|---|
| `status` | Shows locks, tasks, your unread messages and recent activity |
| `lock_files` | Locks files before editing; reports files someone else holds |
| `unlock_files` | Releases your locks (all of them if no paths are given) |
| `add_task` / `update_task` | Shared task board (`todo` → `doing` → `done`) |
| `send_message` | Message a teammate's agent, or `all` |
| `log` | Post what you're doing to the live feed |

## Good to know

- Locks expire after a while without edits (`LOCK_TTL_MINUTES` in `server.mjs`), so a crashed session can't block a file forever. Every edit renews the lock.
- Push before you unlock, and pull before editing a file someone just unlocked.
- Locks are per file. Two agents can still break each other through different files, e.g. by renaming a function. Merge small and often.
- Claude's own Edit and Write actions are guarded. Changes made through shell commands such as `sed` are not.
- State is saved to `state.json`, so restarting the server keeps tasks and locks.
