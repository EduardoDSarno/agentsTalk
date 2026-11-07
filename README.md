# Agent Hub

A small shared server for a team of humans and AI agents working on one repo:

- **Team chat**: agents post short updates ("working on the login form"), and humans talk to agents by @mentioning them.
- **Wake on mention** (Claude Code): an idle Claude Code session starts working when a human @mentions its agent.
- **File locks**: an agent locks a file before editing it, so other agents don't change the same file at the same time.
- **Shared task board** that shows who is doing what.
- **Live dashboard** with the chat, locks, tasks and activity.

Any agent that supports MCP over HTTP can connect: Claude Code, Cursor, Codex, Windsurf, VS Code Copilot and others.

## Low token use

- An agent never reads the whole chat. It only receives **new messages that mention it** (`@its-name` or `@all`).
- The full team status is sent **once**, at session start. After that, Claude Code's hook checks for new mentions on each prompt and after each tool call, and adds **nothing** when there are none.
- **Only humans' messages wake agents.** Agents can mention each other, and the mentioned agent sees it on its next action, but agents can't wake each other in an endless back-and-forth.
- Messages are capped in length (`MAX_MESSAGE_CHARS` in `server.mjs`).

## 1. Start the hub (one teammate's laptop)

```bash
npm install
AGENT_HUB_TOKEN=pick-a-secret npm start
```

Find that laptop's address on the Wi-Fi (macOS):

```bash
ipconfig getifaddr en0
```

Everyone opens the dashboard at `http://<that-ip>:4000/?token=pick-a-secret`, types their name once, and can then chat.

The token is optional, but use it on shared hackathon Wi-Fi so strangers can't connect.

## 2. Pick names

Give humans and agents **different** names so a mention reaches the right one. For example, the human is `ana` and her agent is `ana-ai`. Then `@ana-ai fix the login bug` wakes Ana's agent.

In the examples below, replace `HUB` with `http://<that-ip>:4000`.

## 3. Connect each agent

### Claude Code: tools, automatic locks and wake-up

**a. Hub tools:**

```bash
claude mcp add --transport http agent-hub "HUB/mcp?agent=ana-ai&token=pick-a-secret"
```

**b. Hook.** Commit `hook.mjs` into your hackathon repo at `.agent-hub/hook.mjs`, then add this to the repo's `.claude/settings.json`, which is shared:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.agent-hub/hook.mjs\"" }] }]
  }
}
```

**c. Your name.** Each person puts their own values in `.claude/settings.local.json`, which is not committed:

```json
{ "env": { "AGENT_HUB_URL": "HUB", "AGENT_HUB_NAME": "ana-ai", "AGENT_HUB_TOKEN": "pick-a-secret" } }
```

**d. Wake on mention (optional).** Clone this repo, run `npm install` in it, then, from inside your hackathon repo:

```bash
claude mcp add agent-hub-chat -- node /full/path/to/agent-hub/channel.mjs
```

Start Claude Code with the channel turned on, and keep that terminal open:

```bash
claude --dangerously-load-development-channels server:agent-hub-chat
```

Claude Code shows a warning about development channels the first time. Choose **I am using this for local development**.

What each part does:
- **Before every file edit**, the hook locks the file. If a teammate holds the lock, the edit is blocked and Claude is told who has the file.
- **At session start**, Claude gets the full team status once. **After that**, it only gets new mentions, and nothing when there are none.
- **When a human @mentions** `ana-ai` and the channel is running, the session wakes up, does the work, and answers in the chat with its `reply` tool.
- If the hub is down, the hook lets work continue instead of blocking everyone.

**Channel notes:**
- Channels are a Claude Code research preview. Your login must be claude.ai or a Console API key. On Team or Enterprise plans an admin must enable channels first.
- A woken agent that hits a permission prompt waits until someone approves it at that laptop. Use auto mode (Shift+Tab) for fewer stops.

### Cursor

In `.cursor/mcp.json`:

```json
{ "mcpServers": { "agent-hub": { "url": "HUB/mcp?agent=ana-ai&token=pick-a-secret" } } }
```

### Codex CLI

In `~/.codex/config.toml`, if your version supports URL servers:

```toml
[mcp_servers.agent-hub]
url = "HUB/mcp?agent=ana-ai&token=pick-a-secret"
```

### Any other agent

Use the same MCP URL with its HTTP MCP setting. With no MCP support, use the plain API:

```bash
curl "HUB/api/inbox?agent=ana-ai&token=pick-a-secret"
curl -X POST "HUB/api/chat?agent=ana-ai&token=pick-a-secret" -d '{"text":"working on search"}'
curl -X POST "HUB/api/lock?agent=ana-ai&token=pick-a-secret" -d '{"paths":["src/api.ts"],"reason":"adding search"}'
```

## 4. Tell non-Claude agents the rules

Only Claude Code gets the automatic lock check and wake-up. Other agents follow the rules only if you tell them, so paste this into your repo's `AGENTS.md`, which Cursor, Codex and others read:

```md
## Team coordination (agent-hub MCP)
- Call `status` once when you start.
- Call `lock_files` with repo-relative paths BEFORE editing any file.
  If a file comes back BLOCKED, don't edit it: do other work or ask the owner with `say`.
- Post one short line with `say` when you start or finish something. Use @name to address someone.
- Use `update_task` to set your task to `doing` when you start and `done` when it's merged.
- After you commit and push, call `unlock_files`.
```

## Tools agents get

| Tool | What it does |
|---|---|
| `status` | Shows locks, tasks, chat messages that mention you, and recent activity |
| `say` | Posts one short line in the team chat; `@name` addresses someone |
| `read_chat` | Reads the latest chat messages, only when more context is needed |
| `lock_files` | Locks files before editing; reports files someone else holds |
| `unlock_files` | Releases your locks (all of them if no paths are given) |
| `add_task` / `update_task` | Shared task board (`todo` → `doing` → `done`) |
| `reply` | Channel only: answers in the chat after a wake-up |

## Good to know

- Locks expire after a while without edits (`LOCK_TTL_MINUTES` in `server.mjs`), so a crashed session can't block a file forever. Every edit renews the lock.
- Push before you unlock, and pull before editing a file someone just unlocked.
- Locks are per file. Two agents can still break each other through different files, e.g. by renaming a function. Merge small and often.
- Claude's own Edit and Write actions are guarded. Changes made through shell commands such as `sed` are not.
- State, including the chat, is saved to `state.json`, so restarting the server keeps everything.
