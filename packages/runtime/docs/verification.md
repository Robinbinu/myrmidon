# Verification

- **Task review.** When a task is submitted, the verifier checks its files (and, if configured, a judge
  model reviews them). The owner hears VERIFIED or REJECTED with evidence; leads hear about every task.
- **The reviewer.** An independent judge model scores the whole result (the conversation, the final answer, and
  the files) against a rubric. When it runs depends on the person's reviewer setting:
  - **off**: never. `reply_user(final: true)` completes the round.
  - **auto**: when the speaking agent calls `request_review(summary)`. The verdict and its findings come back to
    the agent, which fixes what matters and then sends the final answer, and that completes the round. Ask for it
    for code, files, and research with sources; skip it for simple answers and for a few-line fix whose tests the
    agent ran and saw pass.
  - **always**: on every final answer. At or above the threshold the round is *completed*. Below it, the findings
    are sent back; fix them and send an updated final answer. After repeated failures the round stops with the
    report.
- **By kind of work.** The judge reads what the round did and judges each kind its own way: code by whether it
  works (checks, the diff, edge cases, no stubs); research by checking the main claims against the pages they cite,
  which it fetches (reusing pages you already fetched), so a citation its page contradicts, or a page that does
  not exist, is a major finding; browser tasks against what the browser actually showed; writing by whether it answers
  exactly what was asked, in the form asked for. Cite the specific page for each key claim.
- **The judge can be another model.** The person picks it; the composer suggests one from another provider than
  the team, since a different model does not share the team's blind spots.
- **In a project**, the judge also reads the round's diff of the project folder and, if you changed files, runs the
  project's own checks (the same ones `run_checks` runs). Work that breaks a check is not done. Its findings come
  graded — `[blocker]`, `[major]`, `[minor]`, each with where — so fix blockers first.
- Claiming success does nothing, and reviews check claims against the work. Never fabricate results.
