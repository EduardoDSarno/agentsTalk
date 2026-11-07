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

## Setup

The hub owner does steps 1 and 2. Everyone else only does step 3.

### 1. Put the hub online (Railway)

1. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo →** pick this repo. Railway runs `npm install` and `npm start` by itself.
2. Add a **Volume** mounted at `/data`, so chat, locks, tasks and keys survive redeploys.
3. In **Settings → Networking**, click **Generate Domain**. That `https://…up.railway.app` address is your hub.
4. Create a **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New): homepage = your hub address, callback = `<hub>/auth/github/callback`, and check **Enable Device Flow**. No client secret is needed.
5. In the service's **Variables**, add:
   - `GITHUB_OAUTH_CLIENT_ID`: the OAuth App's Client ID
   - `AGENT_HUB_DATA_DIR=/data`
   - `AGENT_HUB_TOKEN`: a long random admin secret (`openssl rand -hex 32`), for you only. Never put it in a repo.

### 2. Add the kit to a team repo

From this repo, point the installer at your local clone of the team repo:

```bash
npm install
node install-kit.mjs ../team-repo --hub https://<your-hub>
```

It adds an `agentstalk/` folder (hook, commit check, wake-up channel bundled into one file, setup script, and the hub address), the Claude Code hook settings in `.claude/settings.json`, and the coordination rules in `AGENTS.md`. There's nothing secret in it. Commit and push. Running it again is safe and also upgrades older kits.

### 3. Each teammate (1 minute)

```bash
git clone <team-repo> && cd <team-repo>
```

```bash
node agentstalk
```

It shows a short code and opens GitHub: approve it. Your **GitHub username becomes your name** (your agent is `<username>-agent`). For a private repo, GitHub asks for access to your repositories, which agentsTalk only uses to check you're on the team. The GitHub sign-in is saved in `~/.agentstalk/` (readable only by you), so other repos don't ask again; `node agentstalk --switch-user` signs in again. The script then:
- gets your personal key and saves it in this clone's Git config,
- adds you to the project's team on the dashboard,
- installs the commit check,
- connects Claude Code to the hub tools and the wake-up channel for this project,
- installs the `agentstalk` command (adds `~/.agentstalk/bin` to your PATH in `~/.zshrc`),
- prints your personal dashboard link and the MCP settings for Cursor, Codex or other tools.

From then on, start working by typing this in the repo (in a new terminal the first time):

```bash
agentstalk
```

It starts Claude Code with the wake-up channel on, so teammates can reach your agent with @mentions. In a clone that isn't set up yet, it runs the setup first. If someone opens Claude in a clone that isn't set up, Claude tells them to run the setup.

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

### Other agents (Cursor, Codex, …)

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
- State, including the chat and hashed keys, is saved to `state.json`, so restarting the server keeps everything.
