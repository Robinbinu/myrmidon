# Working well in Myrmidon

How strong agents behave here. Read this when you are unsure how to approach a task.

## Before you start

- Restate the goal to yourself: what exactly was asked, what the finished result must contain, and how good it
  must be. "World class", "premium", or "production" mean polished, not a first draft.
- Decide the approach for anything beyond one step: the parts, their order, and how you will check each one.
- Look at what already exists (the snapshot: plan, tasks, files, notes) before creating anything new.

## Doing the work

- Put independent tool calls in one step: several searches or reads at once finish far faster than one by one.
- **Research.** Start with short, broad queries, then narrow. Prefer primary and recent sources; compare their dates
  with today's. Cross-check important facts and numbers in a second source and cite the URLs you used. Stop when
  new results stop changing the answer.
- **Code.** Write complete, runnable code: no placeholders, stubs, or TODOs. With a shell, run it: execute scripts,
  run tests, build or syntax-check pages (`node --check`, `bun build`, `python -m py_compile`). Fix every error
  before publishing.
- **Web pages.** One self-contained file unless asked otherwise; responsive; real content; no broken links or
  console errors.
- **Writing.** Lead with the answer, then the support. Concrete and specific; no filler.
- **Design.** Consistent type scale, spacing, and palette; clear hierarchy; accessible contrast.

## Finishing

- Check your output against the request (or the task's "Done when") point by point, and fix gaps instead of
  describing them.
- Publish only finished, working files with clear names and the right extensions.
- Report honestly: what you did, what you could not do, and any assumptions. Never invent sources or results.
- When a tool fails, read the error and change approach; repeating the same call wastes the budget.

## Leading a team

- Size the plan to the request: one task for a small job, two to four for a typical build, more only for broad
  work. Extra tasks cost time and tokens and coordinate worse.
- Write every task as a standalone brief (the worker sees only it, the plan, and the files):

  ```
  Objective: what to achieve and why.
  Deliverable: exact files (also in outputs) and their format.
  Approach: key steps, sources or tools, constraints, quality bar.
  Done when: concrete checks the result must pass.
  Not in scope: what another task covers.
  ```

- Create independent tasks in one step so they run in parallel; use `blockedBy` only for real dependencies.
- Do not ask for status; verdicts and mail reach you. Review delivered files yourself before the final answer.
