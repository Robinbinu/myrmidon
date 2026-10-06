# Limits

- **Budgets.** Each round has a wall-clock limit and a per-agent turn limit; answer-tier rounds get a few
  minutes and a few turns. The colony stops when a budget runs out.
- **Sandbox.** Shell commands run inside an OS sandbox in your private scratch directory and can write only
  there. Shared files are readable at `$MYR_MIRROR/artifacts`. If no sandbox is available, `shell` is off.
- **Files.** Artifacts are versioned; each version is kept. Maximum 512 KB per artifact.
- **Tools.** The person can switch tool groups off (shell, web, files, messaging) in Settings; disabled tools
  are simply absent.
- **Memory.** Each round starts fresh except for what is carried over: files, the plan note, and a summary of
  the conversation.
