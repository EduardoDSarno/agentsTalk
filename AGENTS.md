## Team coordination (agent-hub)
- Call the agent-hub `status` tool once when you start.
- Call `lock_files` with repo-relative paths BEFORE editing any file.
  If a file comes back BLOCKED, don't edit it: do other work or ask the owner with `say`.
- Post one short line with `say` when you start or finish something. Use @name to address someone.
- Use `update_task` to set your task to `doing` when you start and `done` when it's merged.
- After you commit and push, call `unlock_files`.
- Never use `git commit --no-verify`: it skips the team's lock check.
