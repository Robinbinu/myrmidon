# Lead first — Step 1: no gate, and a Reviewer setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message starts the lead at once, with no triage call. The lead answers simple things directly and
escalates big work. Reviews follow a setting: Off, Auto (the lead asks), or Always.

**Architecture:** `ChatService` stops calling a triage model: the default `classify` returns `solo`. The solo brief
becomes a lead brief that answers directly when it can. A new `review` field on chat specs (from
`settings.verification.reviewer`) decides when the judge runs: in `_verifyFinalAnswer` (Always), never (Off), or
through a new `request_review` tool the speaking agent may call (Auto). The UI swaps team wording for the lead, and
"Judge" for "Reviewer".

**Tech Stack:** Bun, TypeScript, Schemastery, pi-agent-core mocks in `bun test`, React.

**Spec:** `docs/superpowers/specs/2026-10-07-lead-first-design.md` (step 1).

## Global Constraints

- The `classify` hook stays (tests inject fixed tiers; escalation reruns pass `tier`). Only the LLM triage is removed.
- `judgeModel` keeps its name in the API, config and settings. The UI calls it the Reviewer.
- A chat spec without `review` behaves as Always, so old logs and stores without settings keep today's behaviour. The
  settings default is `auto`.
- CLI colony specs (`myrmidon run`) are untouched.
- `$SCRATCH` = `/private/tmp/claude-501/-Users-robin-Desktop-Myrmidon/14e23d6b-d916-4324-acd9-e5896e74cca2/scratchpad`.
  Commit only after `bun run check > "$SCRATCH/check.log" 2>&1; rc=$?` gives 0, and only the files listed.
- The person's dev server (4318, `bun run dev`) hot-reloads every edit, so never leave a half-edited file between
  steps.

---

### Task 1: Rounds start with the lead (no triage)

**Files:**
- Modify: `packages/runtime/src/chat.ts`
  - remove `TRIAGE` and `llmClassifier`;
  - the default classify returns `'solo'`;
  - drop the `.catch` retry chain around classify.
- Modify: `packages/runtime/src/patterns.ts`
  - the solo chat brief answers directly when it can;
  - `thinkingFor` gives a single chat agent `spec.thinking ?? 'medium'`.
- Modify: `packages/runtime/src/index.ts` if it exports `llmClassifier`.
- Modify: `apps/eval/src/cases.ts` — `'answer'` in `tiers` becomes `'solo'`.
- Test: `packages/runtime/tests/chat.test.ts`.

- [ ] **Step 1: Failing test.** Add after the "answer tier" test:

```ts
test('a new message starts the lead at once: one agent with every tool, no triage call', async () => {
  const resolver = new ModelResolver()
  let calls = 0
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      calls += 1
      expect(ctx.tools?.map((t) => t.name)).toContain('escalate')
      return [tool('reply_user', { text: '4', final: true })]
    },
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver })
  const { colonyId } = await chats.send('What is 2+2?', solo('mock/lead'))
  const s = await waitFor(colonyId)
  expect(calls).toBe(1)
  expect(s.tier).toBe('solo')
  expect(Object.keys(s.agents)).toEqual(['lead'])
  expect(s.chatMessages.at(-1)?.text).toBe('4')
  await chats.stopAll()
})
```

Note: `solo('mock/lead')` uses `mock/lead` as the judge too, and the "team" escalation needs `teamSize > 1`. If the
`escalate` assertion fails because the config has no workers, pass
`{ ...solo('mock/lead'), extraWorkers: 2, judgeModel: 'mock/judge' }` instead. The assertion is about the tool
being offered.

- [ ] **Step 2:** `bun test packages/runtime/tests/chat.test.ts -t "starts the lead at once"`. Expect FAIL: today the
  default classifier returns `team` for mock models, so the agents are a lead plus workers.
- [ ] **Step 3: Implement.**
  - In `chat.ts`, delete `TRIAGE` and `llmClassifier`.
  - Replace the classify block in `deliver` with:

```ts
    // The lead starts at once and sizes the work itself (escalate); tests and reruns may fix the size instead.
    const tier = options.tier ?? (await (this.options.classify ?? leadFirst)(message, history))
```

  - Add near `Classify`:

```ts
/** Every new round starts with one lead that has every tool and escalates big work itself. */
const leadFirst: Classify = async () => 'solo'
```

  - Update `Classify`'s doc comment to: `/** Sizes a round before it starts; by default the lead does this itself, so new rounds start solo. */`.
  - In `patterns.ts` `roleBrief`, the solo chat brief becomes:

```ts
    return `You are the person's lead and work with every tool. When you can answer directly (a question, an
explanation, a quick fact), lead with the answer right away: no plan, no files. When the request needs work, plan
briefly, do it, verify it (run the code, check the facts), publish the files with publish_artifact, then send the
final answer with reply_user(final: true).${escalationNote(spec)}`
```

  - In `thinkingFor`, after `if (spec.thinking) return spec.thinking`, add
    `if (spec.chat && spec.agents.length === 1) return 'medium'`. A lone chat agent answers quickly; it thinks harder
    only when the person asks for more thinking.
  - `grep -rn "llmClassifier" packages apps` and remove any export or import left.
  - In `apps/eval/src/cases.ts`, run `perl -pi -e "s/tiers: \['answer'\]/tiers: ['solo']/; s/tiers: \['answer', 'solo'\]/tiers: ['solo']/" apps/eval/src/cases.ts`.
- [ ] **Step 4:** Run the new test. Expect PASS. Then the full `bun test packages/runtime/tests/chat.test.ts`; tests
  that inject `classify` are unaffected.
- [ ] **Step 5:** Check, then commit `chat.ts patterns.ts index.ts(if changed) cases.ts chat.test.ts`:
  "Rounds start with the lead: no triage call before a message".

### Task 2: Reviewer setting reaches the round

**Files:**
- `packages/runtime/src/settings.ts`:
  - `verification: { threshold: number; rubric?: string; reviewer: 'off' | 'auto' | 'always' }`;
  - schema `reviewer: Schema.union(['off', 'auto', 'always']).default('auto')`.
- `packages/runtime/src/spec.ts`:
  - `/** Chat rounds: when the reviewer (judge) runs. Absent means always. */ review?: 'off' | 'auto' | 'always'`.
- `packages/protocol/src/payloads.ts`:
  - `review?: 'off' | 'auto' | 'always'` on `colony/created`, next to `askTools`.
- `packages/runtime/src/events.ts`:
  - `review: Schema.union(['off', 'auto', 'always'])` next to `askTools`.
- `packages/runtime/src/colony.ts` `_specPayload`:
  - `...(this.spec.review ? { review: this.spec.review } : {})`.
- `packages/runtime/src/chat.ts`:
  - `specFromLog` carries `review`, mirroring `askTools`;
  - `buildSpec` sets it, as below.

```ts
    // Without a settings store (tests, bare runtimes) every final answer is reviewed, as before the setting.
    const review = s?.verification.reviewer ?? 'always'
```

and `acceptance: review === 'off' || (tier === 'answer' && review !== 'always') ? [] : [ …judge… ]`, plus `review,` in
the returned spec.

- [ ] Settings test: add to `packages/runtime/tests/settings.test.ts` (or wherever settings parsing is tested):
  a fresh store reads `verification.reviewer === 'auto'`, and setting `'off'` round-trips. Run it, implement, run
  again, check, commit "Reviewer setting: off, auto or always, carried into chat rounds".

### Task 3: Review modes at work

**Files:**
- `packages/runtime/src/host.ts` — `requestReview(by: string, summary: string): Promise<string>`.
- `packages/runtime/src/colony.ts`:
  - `requestReview`;
  - `_verifyFinalAnswer` honours `review`;
  - shared `_mergeWorktrees()` used by both review paths.
- `packages/runtime/src/tools.ts` — the `request_review` tool.
- `packages/runtime/src/patterns.ts`:
  - `roleTools` offers `request_review` to the speaker in Auto;
  - the speaker suffix describes the mode.
- Test: `chat.test.ts`.

- [ ] **Failing tests** (one `test` each; use `SettingsStore` as the per-tool rules test does):
  1. **Off.** With `verification.reviewer = 'off'`, a solo round's final answer completes with a `delivered` verdict,
     and no `verifier/requested` event appears.
  2. **Auto.**
     - The lead's tools include `request_review`.
     - A script calls `request_review({summary:'poem.txt'})`, then `reply_user(final)`.
     - Exactly one `verifier/requested` is logged, it precedes the final reply, and the round completes.
     - A script that only replies completes with no `verifier/requested`.
  3. **Always.** As today: the final answer triggers `verifier/requested`, and the round completes on the judge's
     pass.
- [ ] **Implement.**

`colony.ts`:

```ts
  /** Brings every worker's changes into the project; returns why that failed, or nothing. */
  private async _mergeWorktrees(): Promise<string | undefined> {
    const conflicts: string[] = []
    for (const name of Object.keys(this._state.worktrees))
      await this.mergeWork(name).catch((err: Error) => conflicts.push(`${name}: ${err.message}`))
    return conflicts.length ? conflicts.join('\n') : undefined
  }

  /** Auto review: the speaker asks the reviewer to check the work so far; the verdict goes back to it, the round goes on. */
  async requestReview(by: string, summary: string): Promise<string> {
    if (this._finalRunning) return 'a review is already running; wait for its verdict'
    const conflicts = await this._mergeWorktrees()
    if (conflicts) return `NOT REVIEWED: workers' changes could not be merged into the project yet.\n${conflicts}`
    this._finalRunning = true
    this._verifying += 1
    try {
      await this.append({ type: 'verifier/requested', actor: { kind: 'agent', id: by }, payload: { target: 'colony', by } })
      const result = await this._verifier.verifyColony()
      return result.pass
        ? `REVIEW PASSED.\n${result.report}\nSend the final answer with reply_user(final: true).`
        : `THE REVIEWER FOUND PROBLEMS (${by}'s summary: ${summary.slice(0, 300)}):\n${result.report}\nFix them, then ask for another review or send the final answer.`
    } finally {
      this._finalRunning = false
      this._verifying -= 1
    }
  }
```

  - `requestFinalVerification` uses `_mergeWorktrees()` in place of its inline loop (same message text as today).
  - `_verifyFinalAnswer`: the first branch condition becomes
    `this.spec.acceptance.length === 0 || this.spec.review === 'off' || this.spec.review === 'auto'`, with evidence
    `this.spec.review === 'auto' ? 'Final answer delivered; the agent asks for a review when the work needs one.' : 'Final answer delivered; this round is not reviewed.'`.

`tools.ts` (next to `request_final_verification`):

```ts
  {
    name: 'request_review',
    tier: 'write',
    description:
      'Ask the independent reviewer to check your work against the request before you send the final answer: worth ' +
      'it for code, files, or research with sources; skip it for simple answers. It returns the verdict and what to ' +
      'fix; the round goes on until you send the final answer.',
    parameters: type({ summary: type('string').describe('What you did and where (files, sources)') }),
    async run(args, agent, host) {
      return host.requestReview(agent, args.summary)
    },
  },
```

`patterns.ts`:

```ts
    // In auto review the speaker decides when the reviewer looks at the work.
    const review =
      spec.review === 'auto' && spec.acceptance.length > 0 && speaksForColony(spec, agent) ? ['request_review'] : []
```

Add `...review` to the answer list, the solo list and the orchestrated lead list in the chat branch of
`roleTools`. Replace the speaker suffix ternary in `systemPrompt` with `reviewNote(spec)`:

```ts
function reviewNote(spec: ColonySpec): string {
  if (spec.acceptance.length === 0 || spec.review === 'off')
    return 'Your final answer is not reviewed: it completes the round as soon as you send it, so get it right first.'
  if (spec.review === 'auto')
    return 'Your final answer completes the round. For work worth checking (code, files, research with sources), call request_review first and fix what it finds; skip it for simple answers.'
  return 'An independent reviewer then checks the work; if it finds problems, fix them and send an updated final answer.'
}
```

- [ ] Run the three tests, then the whole chat test file. Check, then commit "Reviewer modes: off, auto (the lead
  asks with request_review), always".

### Task 4: UI — the lead, not the team; Reviewer, not Judge

**Files:**
- `apps/web/src/client/chat/RoundView.tsx`:
  - `PendingRound` drops `STARTING` and the step list, showing "Thinking…" beside the face;
  - "Verified by an independent judge" becomes "Reviewed";
  - "Judge asked for changes" becomes "The reviewer asked for changes".
- `apps/web/src/client/chat/Composer.tsx`:
  - the chip at line ~625 shows the lead's model name only;
  - the "Judge" label becomes "Reviewer", with the sameJudge hint wording to match.
- `apps/web/src/client/Settings.tsx`:
  - `ServerSettings.verification` gains `reviewer`;
  - the section label and hint become `{ id: 'verification', label: 'Reviewer', hint: 'Off, auto or always' }`;
  - `VerificationSection` gets a heading "Reviewer" with an Off / Auto / Always `Segmented` row and a short hint for
    each mode;
  - the threshold and rubric rows say "reviewer" and are disabled when Off.

- [ ] Implement, `bun run check`, then a visual pass on 4319:
  - send "What is 2+2?" and see the face with "Thinking…" and no team words;
  - set Reviewer to Off, Auto and Always in Settings and see each round's footer match.
- [ ] Measure with `bun $SCRATCH/timing.ts "What is 2+2?"` and record the numbers in the commit message. Commit "Lead,
  not team: the waiting card thinks, the composer names the lead, Reviewer replaces Judge".
