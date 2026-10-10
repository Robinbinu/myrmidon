# Team modes

The person picks the team mode for **team** rounds. Every request starts with one lead that has every tool.

When the lead finds the request needs several specialists in parallel, it calls `escalate(to: team, reason)` early
rather than doing a thin version. The round ends, and the next round reruns the same request as a team with its
files, notes, conversation and the reason. A team is offered only when the person has one configured.

## Orchestrated

A **lead** plans the job and hands each part to a **crewmate**. Each crewmate has a role
(researcher, coder, writer, reviewer, …) and may run on a different model chosen for that role.

- Crewmates are asleep until the lead assigns them a task (`create_task` with `assignee`, or `assign_task`).
  An assigned crewmate wakes with the task, the plan, and the current files.
- The lead plans, assigns, reviews, integrates, and speaks to the person. By default it also has its crew's tools
  (files, commands, web, browser) for small pieces: a quick lookup, a short fix, the integration. Independent or
  parallel work still goes to crewmates with `create_task`. The person can take those tools away from the lead
  (Settings → Permissions, "Who can use what"); then research and building go to the crewmates, who have them.
- Crewmates on call show in `list_agents` before they join; `ask_crewmate` reaches only those.
- The lead may add more crewmates with `add_crewmate(role, focus, model)` up to the team limit, or bring in
  one of the person's specialists (crewmates they saved in Settings) by name.
- When a request is small enough for the lead to work alone (a solo round), the crew stays on call: the lead
  asks one crewmate for a piece of work with `ask_crewmate(to, job)`. The crewmate joins, does the job, and
  answers the lead by `message`; that answer comes back as the tool's result. Several asks in one step run in
  parallel. `escalate` is for when the whole request needs the team.
- The team persists across a conversation: each follow-up round brings back the same crewmates, each with its own memory of earlier rounds (recent turns in full, older tool output elided). The
  lead lets a crewmate go with `dismiss_crewmate(name, reason)`; dismissed crewmates do not come back.
- Crewmates do one task at a time: claim it, do it, publish its outputs, submit it, stop. They never talk to
  the person; blockers go to `@lead` on the board.

## Swarm

Equal **crewmates** share one goal. There is no boss: the shared **notes** and **task board** are the only
coordination (a blackboard).

- Every round opens with a **huddle**. All crewmates wake, see who else is on the team, and each posts one board
  message proposing how to split the request and which part it will take. Until the huddle ends only
  looking and talking tools work (read, list, `post`, mail); nobody starts the work alone.
- The huddle ends when every crewmate has proposed (or after 90 seconds). The crewmate who proposed first merges
  the proposals into the single **plan** note and creates the tasks, each assigned to the crewmate who
  volunteered for it with the files it will produce; each crewmate is woken by its assignment.
- Crewmates claim one task at a time. Nobody re-plans; crewmates refine the plan by splitting tasks or appending
  `decision` and `finding` notes.
- Duplicate tasks are refused, a task's output files can only be published by the crewmate holding it, and a
  held task is released if its holder goes quiet.
- When every task is verified, the colony picks a **speaker** (the crewmate that finished the most tasks) and
  gives it the `task-final` task: write the final answer from the verified files and notes. Crewmates never
  create their own "final answer" or "final review" task; it would only block `task-final`.
- Only the speaker may answer the person; any crewmate may `ask_user` if the whole colony is blocked.
