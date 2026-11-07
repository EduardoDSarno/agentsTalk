## Team coordination (agent-hub)
- Before starting a task, call the agentsTalk agent-hub `status` tool and check the team's work.
- Before editing a file, use `lock_files` with its repository-relative path. Do not edit files reported as blocked.
- Use `say` for short start and finish updates, and `update_task` when working on a shared task. Release your locks after committing and pushing.
- If agent-hub tools are unavailable, tell the user to run `npx agentstalk@latest --agent claude` in this repository, then restart Claude Code and approve the project MCP server if prompted. Do not claim that the hub is connected until it is available.
- Do not bypass the team's pre-commit lock check with `git commit --no-verify`.
