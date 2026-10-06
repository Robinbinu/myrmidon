# Team modes

The person picks the team mode for **team**-tier requests. Answer and solo requests always use one agent.

## Orchestrated

A **lead** plans the job and hands each part to a **specialist worker**. Each specialist has a role
(researcher, coder, writer, reviewer, …) and may run on a different model chosen for that role.

- Workers are asleep until the lead assigns them a task (`create_task` with `assignee`, or `assign_task`).
  An assigned worker wakes with the task, the plan, and the current files.
- The lead plans, assigns, reviews, integrates, and speaks to the person. It does not write code or run
  commands itself in a team; that is what the specialists are for.
- The lead may add more specialists with `spawn_worker(role, focus, model)` up to the team limit.
- The team persists across a conversation: each follow-up round brings back the same workers (and swarm
  peers), each with its own memory of earlier rounds (recent turns in full, older tool output elided). The
  lead lets a worker go with `dismiss_worker(name, reason)`; dismissed workers do not come back.
- Workers do one task at a time: claim it, do it, publish its outputs, submit it, stop. They never talk to
  the person; blockers go to `@lead` on the board.

## Swarm

Equal **peers** share one goal. There is no boss: the shared **notes** and **task board** are the only
coordination (a blackboard).

- Every round opens with a **huddle**. All peers wake, see who else is on the team, and each posts one board
  message proposing how to split the request and which part it will take. Until the huddle ends only
  looking and talking tools work (read, list, `post`, mail); nobody starts the work alone.
- The huddle ends when every peer has proposed (or after 90 seconds). The peer who proposed first merges
  the proposals into the single **plan** note and creates the tasks, each assigned to the peer who
  volunteered for it with the files it will produce; each peer is woken by its assignment.
- Peers claim one task at a time. Nobody re-plans; peers refine the plan by splitting tasks or appending
  `decision` and `finding` notes.
- Duplicate tasks are refused, a task's output files can only be published by the peer holding it, and a
  held task is released if its holder goes quiet.
- When every task is verified, the colony picks a **speaker** (the peer that finished the most tasks) and
  gives it the `task-final` task: write the final answer from the verified files and notes. Peers never
  create their own "final answer" or "final review" task; it would only block `task-final`.
- Only the speaker may answer the person; any peer may `ask_user` if the whole colony is blocked.
