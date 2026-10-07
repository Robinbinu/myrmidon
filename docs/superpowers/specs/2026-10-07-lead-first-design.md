# Lead first — Design Spec

- **Date:** 2026-10-07
- **Status:** Approved ("go ahead in that order"), with the reviewer setting added by the person
- **Scope:** how a chat round starts, how its reply reaches the screen, how helpers appear, and when work is reviewed

## 1. Problem

Sending a message does not feel like talking to someone:

- **Triage gate.** Before any agent starts, a separate model call sorts the request into answer, solo or team. That
  costs about 4–7 s per message. Measured on the test server with DeepSeek V4 Pro:

  | Message | Round started | Reply visible |
  |---|---|---|
  | "What is 2+2?" | 7.3 s | 12.6 s |
  | "Write a haiku" | 4.6 s | 9.4 s |

- **No streaming.** The reply appears only once it is complete.
- **Team-first wording.** The UI talks about the team first: "Choosing the right team", "Waking the agents",
  "· 2 specialists" on the composer, and an independent judge on "2+2".

## 2. Goal

The person talks to one lead. The lead answers at once when it can and does moderate work itself. Only for big,
multi-part work does it bring in helpers, as Anthropic's research system scales effort to the request ("simple queries
use 1 agent; complex ones use 10+"). Reviews follow a setting the person chooses.

## 3. Design

### Step 1: no gate, and a reviewer setting

- **Rounds start with the lead.**
  - A new round no longer calls the triage model. It starts as one lead with every tool (today's solo round).
  - The lead is briefed to answer directly when it can, to do moderate work itself, and to call
    `escalate(to: 'team')` early when the work is big and multi-part. A rerun at team size keeps the files, notes
    and conversation, as escalation does today.
  - The `classify` hook on `ChatService` stays, for tests and for escalation reruns that already know their size.
    Its default is "solo", and `llmClassifier` with its triage prompt are removed.
  - Thinking effort for this lead follows the chat's thinking setting, defaulting to medium rather than high, so
    replies to quick questions stay quick.
- **Reviewer** (the person's term for the judge), set in Settings → Reviewer:
  - **Off:** nothing is reviewed. A final answer completes the round, recorded as delivered.
  - **Auto (default):** the speaking agent has a `request_review(summary)` tool. It runs the reviewer on the work so
    far and returns the verdict and its feedback to the agent, without ending the round. The agent fixes what was
    found if it needs to, then sends the final answer, which completes the round. Nothing runs automatically.
  - **Always:** every final answer is reviewed before the round completes, as solo and team rounds are today.
    Answer-tier rounds are included.
  - The setting is stored as `verification.reviewer: 'off' | 'auto' | 'always'` next to the threshold and rubric. It
    reaches the round as `spec.review`.
  - Colony specs run from the CLI (`myrmidon run`) keep their own acceptance checks and are unaffected.
  - The UI says "Reviewer" and "Reviewed" where it said "Judge" and "Verified by an independent judge". The
    internal name `judgeModel` stays in the API and config.
- **Wording.**
  - The waiting card shows the lead's face and "Thinking…" with the clock and progress sweep, and no team steps.
  - The composer's model chip names the lead's model only. The team setup stays behind it, unchanged.

### Step 2: streaming

- While the lead writes, its text streams to the page as it arrives: the `text` argument of `reply_user`, read from
  the partial tool-call JSON. Before any text appears, the page shows a "Thinking…" shimmer.
- The live updates travel on the colony's existing WebSocket as short-lived messages. They are not events and never
  enter the log, which still stores only the finished `chat/reply`. A client that reconnects simply waits for the
  finished reply.
- Built: pi-agent-core emits `message_update` with the partial assistant message, and providers parse partial
  tool-call arguments while streaming. The speaking agent forwards the `reply_user` text (or a plain-text answer) at
  most every 100 ms and once more at `message_end` (`ColonyHost.streamed` → `ChatService.onStream` → a
  `{type: 'stream'}` socket message). The page shows it with a caret until the finished reply lands in the log.

### Step 3: helpers appear quietly

- When the lead brings agents in (an escalation, or `spawn_worker`), the chat shows one compact, expandable line:
  "Brought in nova (research) and kai (frontend)". The team, tasks and terminals stay in the workspace.
  Built: a round the lead runs (alone, adding helpers, or the team round an escalation hands over to) keeps the chat
  layout with this line; a team the person asked for ("helpers: always") or a swarm keeps the run card.
- A round that is a single direct answer drops the round card and review badge, keeping a quiet footer (duration,
  and "reviewed" when it was).

### Chat first (the person's follow-up, approved: "Lead decides")

- A round the lead handles alone reads as a chat: the reply as a plain assistant message (no "final answer" box) and
  one quiet line under it. While working, the line shows the lead's face, what it is doing and a clock; once done, it
  shows "Done in 12s · 5.6k tokens · 3 steps", and the steps open underneath. The run card appears only for team
  rounds.
- The Helpers chip offers Never (the lead has no escalate tool), Auto (the lead brings helpers in when the work
  needs them; the default) and Always (every round starts as the team, `TeamConfig.helpers: 'always'`).

## 4. Testing

- Runtime tests:
  - a new round starts without a classifier call, and its spec is one lead with every tool;
  - `escalate` still reruns at team size;
  - for each reviewer mode, the final answer is judged automatically (Always), completes undelivered-to-judge (Off),
    or completes directly while `request_review` returns a verdict without ending the round (Auto).
- Timing: the same two messages on the test server should start in about 1 s, not 5–7 s.
- UI: the waiting card and composer chip carry no team wording, and Settings shows the three reviewer modes.
