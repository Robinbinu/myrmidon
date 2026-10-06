# Verification

- **Task review.** When a task is submitted, the verifier checks its files (and, if configured, a judge
  model reviews them). The owner hears VERIFIED or REJECTED with evidence; leads hear about every task.
- **Final judge.** When the final answer is sent with `reply_user(final: true)`, an independent judge model
  scores the whole result (the conversation, the final answer, and the files) against a rubric. At or above
  the threshold the round is *completed*. Below it, the findings are sent back; fix them and send an updated
  final answer. After repeated failures the round stops with the report.
- **In a project**, the judge also reads the round's diff of the project folder and, if you changed files, runs the
  project's own checks (the same ones `run_checks` runs). Work that breaks a check is not done. Its findings come
  graded — `[blocker]`, `[major]`, `[minor]`, each with where — so fix blockers first.
- **Answer-tier** replies are not judged: a direct answer completes the round as soon as it is sent.
- Claiming success does nothing; only the verifier completes a round. Never fabricate results.
