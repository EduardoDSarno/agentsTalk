# agentsTalk

A small shared server for a team of humans and AI agents working on one repo:

- **Team chat**: agents post short updates ("working on the login form"), and humans talk to agents by @mentioning them.
- **Wake on mention** (Claude Code): an idle Claude Code session starts working when a human @mentions its agent.
- **File locks**: an agent locks a file before editing it, so other agents don't change the same file at the same time.
- **Shared task board** that shows who is doing what.
- **Live dashboard** with the chat, locks, tasks and activity.

Any agent that supports MCP over HTTP can connect: Claude Code, Cursor, Codex, Windsurf, VS Code Copilot and others.

## Who can join: GitHub decides

There are no shared secrets in team repos, so they can be public.

- A teammate signs in with GitHub once. The hub asks GitHub whether they can **write** to the repo; only then does it give them a **personal key**.
- The key stays on their computer (Git config and Claude Code settings), and is always sent in a header, never in a URL.
- The key fixes who they are and which repo they're in, so nobody can post as someone else or see another team's repo.
- The team is simply the people with write access on GitHub. Add a collaborator on GitHub and they can join.

## Low token use

- An agent never reads the whole chat. It only receives **new messages that mention it** (`@its-name` or `@all`).
- The full team status is sent **once**, at session start. After that, Claude Code's hook checks for new mentions on each prompt and after each tool call, and adds **nothing** when there are none.
- **Only humans' messages wake agents.** Agents can mention each other, and the mentioned agent sees it on its next action, but agents can't wake each other in an endless back-and-forth.
- Messages are capped in length (`MAX_MESSAGE_CHARS` in `server.mjs`).

## Quick start

Node.js 20 or newer and Git are required. GitHub write access decides who can
join each project's chat; friends appear on the dashboard when they first sign in.
No invitations, shared team keys, or manual room creation are needed.

The CLI uses the shared hub at `https://agentstalk-production.up.railway.app`.

### Repo owner

Inside the GitHub repository you want to share:

```bash
npx agentstalk init
```

The CLI first warns that it will install the team setup, connect your coding
agents, create a commit, and push your current branch to `origin`. Earlier
unpushed commits on that branch will also be uploaded. Type `y` to continue,
then approve GitHub sign-in. Declining leaves the repository untouched.

The CLI detects the repository from `origin`, installs the public kit and
coordination rules, joins its project on the hub, and commits and pushes the
setup files automatically. Existing instructions and agent settings are
preserved. Unrelated staged changes stay out of the setup commit. Save or stash
existing changes to setup files before starting. Git hooks and normal push
checks still apply; a failed push leaves the setup commit available locally.
Use `--yes` to accept the warning explicitly in unattended scripts.

### Friends

Clone the project, enter its directory, and run:

```bash
npx agentstalk
```

Approve the GitHub sign-in. Everyone with write access joins the same project,
gets a personal dashboard link, and can use the chat, file locks and task board.
Your GitHub sign-in is reused across repositories. `--switch-user` signs in again.
The checked-in kit also supports `node agentstalk` without downloading the package.

### Your coding agent

Setup detects installed Claude Code and Codex CLIs. To select one explicitly:

```bash
npx agentstalk --agent codex
npx agentstalk --agent claude
```

Use `--agent none` for dashboard access or manual MCP setup. Other agents can use
the MCP URL and Authorization header printed after joining.

- **Claude Code:** setup connects the hub tools and wake-up channel. Start Claude
  using the channel flag printed by setup to receive human @mentions while idle.
  Edit hooks automatically acquire locks.
- **Codex:** setup adds a project MCP configuration without embedding credentials.
  Start `codex` from the repository root and trust the project to enable its tools.
  The bundled connection reads your key from local Git configuration and supplies
  the current branch when locking files. Run `/hooks` once to trust agentsTalk’s
  edit hooks, and follow `AGENTS.md`. Idle wake-up is specific to Claude Code.

Personal hub keys live in local Git config. The cached GitHub sign-in lives in
`~/.agentstalk/github.json` with owner-only permissions. Never commit or share
personal dashboard links or the credentials printed for manual MCP setup.
Hub keys expire after 30 days; run `npx agentstalk@latest` in the repository to
sign in again. If someone loses repository access, the hub administrator should
revoke their keys immediately: POST to `/api/admin/revoke` with the admin token
in the Authorization header and JSON `{"project":"owner/repo","login":"username"}`.
Existing access is otherwise valid until expiry; GitHub access is checked again
when the person signs in. Keep the Railway volume backed up: hub state is saved
atomically with a recovery copy, but storage loss can still remove both copies.

### Use your own hub

The hub owner can deploy this repository to Railway with `npm start`, a persistent
volume mounted at `/data`, `AGENT_HUB_DATA_DIR=/data`, a private random
`AGENT_HUB_TOKEN`, and `GITHUB_OAUTH_CLIENT_ID` from a GitHub OAuth App with Device
Flow enabled. Railway supplies `PORT`. Set the OAuth App homepage to the hub URL
and its callback to `<hub>/auth/github/callback`.

The repo owner selects a different hub once:

```bash
npx agentstalk init --hub https://your-hub.example.com
```

That URL is saved in the public kit; friends automatically reuse it. HTTPS is
required except for local development on loopback addresses. One shared hub can
serve several repositories, each with separate chat, tasks and locks.

### Develop or release the CLI

```bash
npm ci
npm test
node cli.mjs --help
npm pack
```

`npm pack` builds dependency-free channel and Codex connection bundles into the
package. End users don't need esbuild. Before the package is published to npm,
use `node /path/to/agentsTalk/cli.mjs init` from a target repository, or install a
locally packed tarball. The automatic commit-and-push flow requires npm package
version 1.0.1 or later.

The lower-level installer remains available:

```bash
node install-kit.mjs ../your-project --hub https://your-hub.example.com
```

### Dashboard

Open the personal link the setup prints (`https://<hub>/#key=…`). The key is moved into your browser's storage and removed from the address bar; the part after `#` is never sent to the server. Your name comes from GitHub, so there's nothing to pick. Each repo you join adds its project to the dashboard's project menu.

The hub owner can open `https://<hub>/#admin=<AGENT_HUB_TOKEN>` to see every project.

### Several repos on one hub

Each GitHub repo is its own **project** (named `owner/repo`), with its own chat, locks, tasks and activity, so `src/api.ts` in one repo never blocks `src/api.ts` in another. To add a repo, run step 2 on it; teammates run `node agentstalk` once in each repo.

### Branches

Locks remember the Git branch they were taken on. The hook and the commit check read the current branch on every call, so switching branches is picked up automatically.

- **Same branch**: another agent's lock **blocks** the edit and the commit, because both would overwrite each other.
- **Different branches**: the edit is **allowed**, and both agents get a one-time warning that a merge conflict is likely, so they can coordinate in the chat.

Chat and tasks stay shared across the whole repo. Locks and activity show their branch, and the dashboard's branch menu filters them.

### Codex

The kit adds a `.codex/config.toml` (no secrets) with the hub connection and the same lock hooks. `node agentstalk` detects Codex; then start it with `agentstalk codex`. The first time, Codex asks to trust the folder, and you run `/hooks` once to trust agentsTalk's hooks. Codex has no wake-up, so it sees @mentions before its next tool call instead.

### Other agents (Cursor, …)

The setup prints an MCP server URL (`https://<hub>/mcp`) and a header (`Authorization: Bearer <your key>`). Add both to the tool's MCP settings. These tools don't get the automatic lock check, so they follow the rules in `AGENTS.md`; the commit check still covers their commits. With `lock_files` and `unlock_files` they pass their Git branch.

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
- Claude Code's edits are stopped before they happen. Its shell edits are caught right after, and Claude is told to undo them. Other tools are caught at commit time.
- The commit check can be skipped with `git commit --no-verify`, so the rules tell agents never to use it.
- State, including the chat and hashed keys, lives in a SQLite database (`agentstalk.db` in `AGENT_HUB_DATA_DIR`, using Node's built-in `node:sqlite`, so Node 22.13 or newer). Each change is written in one transaction with write-ahead logging, so a crash or restart never leaves it half-written.
- The first start with an empty database imports an old `state.json` once and renames it to `state.json.imported`. A `state.json` that can't be read stops the hub instead of dropping data.
- A consistent copy of the database is kept in `snapshots/` (one every few hours, the newest 7 are kept). To restore, stop the hub and replace `agentstalk.db` with a snapshot.
- `GET /api/health` answers without a key; set it as the healthcheck path in Railway (Settings → Deploy).
