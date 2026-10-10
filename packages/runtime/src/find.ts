import { relative, resolve, sep } from 'node:path'
import {
  type Api,
  completeSimple,
  type Judge,
  type JudgmentResult,
  type Model,
  type NoulQuestion,
  type TextBackend,
  TextJudge,
} from '@oh-my-pi/pi-ai'
import * as natives from '@oh-my-pi/pi-natives'
import { FIND } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'
import { hideInContext } from './provider-secrets.ts'

/**
 * Semantic file finding, after omp's `find` (pi-coding-agent/src/tools/jfind/): describe a behavior, get the files and
 * line ranges that implement it. omp's pieces are used as a library: query keywords, the IDF-weighted lexical prior
 * from one native grep pass, byte-bounded passages and their sketches, the judge's three request shapes, and the
 * merging of judged ranges. The orchestration (omp's cascade.ts) is ported here, because omp's lists, reads and
 * judges through its session (URL filesystem, judge role); here every file passes the agent's read access before its
 * name or content reaches the judge, and the judge is the person's cheapest model (see `chatJudge`). Without a judge
 * (or when every judge request failed) it ranks by words alone and says so.
 */

const say = prompts.find

/** What find needs from the colony: where to look, what the agent may read, and the model that judges. */
export interface FindScope {
  /** The agent's working directory: paths in the result are relative to it. */
  readonly root: string
  /** The folder or file to search, already resolved for reading. */
  readonly target: string
  readonly isFile: boolean
  mayRead(path: string): boolean
  readonly judge?: Judge
}

export interface FindArgs {
  readonly query: string
  readonly keywords?: readonly string[]
}

type Jfind = {
  keywords: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/keywords')
  lexical: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/lexical')
  passages: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/passages')
  questions: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/questions')
  text: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/text')
  tree: typeof import('@oh-my-pi/pi-coding-agent/tools/jfind/tree')
}
type Passage = ReturnType<Jfind['passages']['windows']>[number]
type HeatRange = ReturnType<Jfind['passages']['mergeHeat']>[number]
type Request = ReturnType<Jfind['questions']['nameBatch']>
type Entry = { path: string; rel: string; size: number }

/** omp's modules, loaded on first use: questions.ts pulls in omp's URL router, a second at startup no round needs. */
async function jfind(): Promise<Jfind> {
  const [keywords, lexical, passages, questions, text, tree] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/tools/jfind/keywords'),
    import('@oh-my-pi/pi-coding-agent/tools/jfind/lexical'),
    import('@oh-my-pi/pi-coding-agent/tools/jfind/passages'),
    import('@oh-my-pi/pi-coding-agent/tools/jfind/questions'),
    import('@oh-my-pi/pi-coding-agent/tools/jfind/text'),
    import('@oh-my-pi/pi-coding-agent/tools/jfind/tree'),
  ])
  return { keywords, lexical, passages, questions, text, tree }
}

/**
 * omp lists, greps and reads through its URL filesystem; for host paths natives reads the disk itself when given
 * none, and readText uses only `readPrefix`.
 */
const DISK = {
  async readPrefix(path: string, bytes: number) {
    return new Uint8Array(await Bun.file(path).slice(0, bytes).arrayBuffer())
  },
} as unknown as Parameters<Jfind['text']['readText']>[0]
const NATIVE_FS = undefined as unknown as natives.ShellFilesystem

interface Stats {
  listed: number
  requests: number
  errors: number
  inputTokens: number
  cost: number
  failures: string[]
}

type Outcome =
  | { ok: true; result: JudgmentResult<Record<string, NoulQuestion>> }
  | { ok: false; error: unknown }

/** A probability the judge gave for `key`, or undefined when it gave nothing usable. */
function noul(outcome: Outcome, key: string): number | undefined {
  if (!outcome.ok) return undefined
  const p = outcome.result.answers[key]?.noul
  return p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

interface Hit {
  rel: string
  score: number
  ranges: HeatRange[]
  lines: number
  partial: boolean
}

/** Runs one search and returns what the agent reads. Judge failures narrow what was judged; they never fail the call. */
export async function find(scope: FindScope, args: FindArgs): Promise<string> {
  const query = args.query.trim()
  if (!query) throw new Error(say.emptyQuery)
  const j = await jfind()
  const words = j.keywords.keywords(query, args.keywords ?? [])
  const started = performance.now()
  const signal = AbortSignal.timeout(FIND.timeoutMs)
  const stats: Stats = { listed: 0, requests: 0, errors: 0, inputTokens: 0, cost: 0, failures: [] }
  const shown = (path: string) => relative(scope.root, path).split(sep).join('/') || path

  const entries = await list(scope, j, signal)
  stats.listed = entries.length
  const index = scope.isFile
    ? undefined
    : await j.lexical.grepIndex(scope.target, words, {
        includeHidden: false,
        filesystem: NATIVE_FS,
        signal,
        timeoutMs: FIND.timeoutMs,
      })
  const weights = index ? j.lexical.idf(index) : words.map(() => 1)
  const none = words.map(() => 0)
  // Only files the agent may read are ranked, judged or read; asking per file stops once the shortlist is full.
  const ranked: { entry: Entry; lex: number }[] = []
  for (const r of entries
    .map((entry) => ({
      entry,
      lex: j.lexical.fileScore(index?.perFileKw.get(entry.rel) ?? none, weights, entry.rel, words),
    }))
    .sort((a, b) => b.lex - a.lex || (a.entry.rel < b.entry.rel ? -1 : 1))) {
    if (ranked.length >= FIND.candidates) break
    if (scope.mayRead(r.entry.path)) ranked.push(r)
  }
  if (ranked.length === 0) return say.nothingToSearch(shown(scope.target))

  const ask = async (request: Request): Promise<Outcome> => {
    try {
      const result = await (scope.judge as Judge).judge(request, { signal })
      stats.requests++
      stats.inputTokens += result.usage.input
      stats.cost += result.usage.cost.total
      return { ok: true, result }
    } catch (error) {
      if (signal.aborted) throw new Error(say.timedOut(Math.round(FIND.timeoutMs / 1000)))
      stats.requests++
      stats.errors++
      const message = `${error instanceof Error ? error.message : String(error)}`
      if (stats.failures.length < 3 && !stats.failures.includes(message)) stats.failures.push(message)
      return { ok: false, error }
    }
  }
  /** At most FIND.parallel requests in flight, each outcome settled as it lands (omp's dispatcher). */
  const dispatch = async <T extends { request: Request }>(
    jobs: readonly T[],
    settle: (job: T, o: Outcome) => void,
  ) => {
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++] as T
        settle(job, await ask(job.request))
      }
    }
    await Promise.all(Array.from({ length: Math.min(FIND.parallel, jobs.length) }, worker))
  }

  // Wave 1: the judge ranks the shortlist by name and place in the tree.
  const nameScore = new Map<Entry, number>()
  if (scope.judge && ranked.length > 2) {
    const project = scope.target.split(sep).pop() ?? ''
    const jobs = chunks(ranked, FIND.nameBatch).map((batch) => ({
      batch,
      request: j.questions.nameBatch(
        project,
        query,
        batch.map((r) => r.entry),
      ),
    }))
    await dispatch(jobs, (job, o) =>
      job.batch.forEach((r, k) => {
        const p = noul(o, j.questions.entryKey(k))
        if (p !== undefined) nameScore.set(r.entry, p)
      }),
    )
  }
  // omp reads the two strongest by words whatever their names, then follows the name scores.
  const selected = ranked.slice(0, Math.min(FIND.files, 2))
  for (const r of [...ranked].sort(
    (a, b) => (nameScore.get(b.entry) ?? 0) - (nameScore.get(a.entry) ?? 0) || b.lex - a.lex,
  )) {
    if (selected.length >= FIND.files) break
    if (!selected.includes(r)) selected.push(r)
  }
  const files = (
    await Promise.all(
      selected.map(async (r) => {
        try {
          const read = await j.text.readText(DISK, r.entry.path, FIND.readBytes)
          const passages = j.passages.selectWindows(
            j.passages.windows(read.text, FIND.windowBytes, words, weights),
            FIND.windows,
          )
          return passages.length
            ? [{ ...r, passages, total: j.text.lines(read.text).length, truncated: read.truncated }]
            : []
        } catch {
          // Binary, blank and vanished files are expected misses (omp does not report them either).
          return []
        }
      }),
    )
  ).flat()

  const judged = scope.judge ? await judgePassages(j, files, query, words, weights, dispatch) : undefined
  const byWords = judged === undefined || (stats.requests > 0 && stats.errors === stats.requests)
  const hits: Hit[] = byWords
    ? wordHits(j, files, shown)
    : (judged as Hit[]).map((h) => ({ ...h, rel: shown(h.rel) }))
  if (!byWords)
    // A prompted judge answers yes or no, so many hits tie: the name judgment and the words break the tie.
    hits.sort((a, b) => b.score - a.score || order(files, a.rel, shown) - order(files, b.rel, shown))

  const out: string[] = []
  const where = scope.target === scope.root ? '' : ` in ${shown(scope.target)}`
  if (hits.length === 0) out.push(byWords ? say.noWords(query, where, words) : say.noHits(query, where))
  else {
    out.push(
      byWords ? say.wordHits(hits.length, query, where) : say.hits(hits.length, query, where, FIND.threshold),
      '',
    )
    for (const h of hits.slice(0, FIND.hits)) {
      out.push(`${h.rel}  ${h.score.toFixed(2)}  ${say.coverage(h.lines, h.partial, !byWords)}`)
      for (const r of j.passages.rankedHeat(h.ranges, FIND.ranges)) {
        const span = r.start === r.end ? String(r.start) : `${r.start}-${r.end}`
        out.push(`  ${h.rel}:${span}  ${r.p.toFixed(2)}  ${r.snippet}`)
      }
    }
    if (hits.length > FIND.hits) out.push(say.moreHits(hits.length - FIND.hits))
  }
  out.push(
    '',
    say.footer({
      listed: stats.listed,
      read: files.length,
      requests: stats.requests,
      tokens: stats.inputTokens,
      cost: stats.cost,
      seconds: (performance.now() - started) / 1000,
    }),
  )
  if (byWords && scope.judge && stats.failures.length) out.push(say.judgeFailed(stats.failures))
  else if (stats.errors > 0) out.push(say.someFailed(stats.errors, stats.requests, stats.failures))
  return out.join('\n')
}

/** Rank among the files read: the order omp's selection gave them (words, then name judgment). */
function order(files: readonly { entry: Entry }[], rel: string, shown: (p: string) => string) {
  const at = files.findIndex((f) => shown(f.entry.path) === rel)
  return at < 0 ? files.length : at
}

/** Every eligible regular file under the target that .gitignore keeps (omp's eligibility: no builds, locks or keys). */
async function list(scope: FindScope, j: Jfind, signal: AbortSignal): Promise<Entry[]> {
  if (scope.isFile) {
    const size = Bun.file(scope.target).size
    return j.tree.eligibleFile(scope.target.split(sep).pop() ?? '', size, true)
      ? [{ path: scope.target, rel: scope.target, size }]
      : []
  }
  // `sortByMtime` is the walker mode that reports sizes (as omp notes); the order is set by rank afterwards.
  const result = await natives.glob({
    pattern: '*',
    path: scope.target,
    recursive: true,
    fileType: natives.FileType.File,
    hidden: false,
    gitignore: true,
    sortByMtime: true,
    signal,
    timeoutMs: FIND.timeoutMs,
  })
  return result.matches.flatMap((m) => {
    const rel = m.path.split('\\').join('/')
    const size = m.size ?? 0
    return j.tree.eligibleFile(rel, size, false) ? [{ path: resolve(scope.target, m.path), rel, size }] : []
  })
}

type Dispatch = <T extends { request: Request }>(
  jobs: readonly T[],
  settle: (job: T, o: Outcome) => void,
) => Promise<void>

/**
 * Waves 2 and 3 of omp's cascade: the judge routes by sketches of every passage, then verifies the most promising
 * passages whole. A sketch is only a routing signal; a reported range always comes from a passage judged whole.
 */
async function judgePassages(
  j: Jfind,
  files: readonly { entry: Entry; passages: Passage[]; total: number; truncated: boolean }[],
  query: string,
  words: readonly string[],
  weights: readonly number[],
  dispatch: Dispatch,
): Promise<Hit[]> {
  const cards = files.flatMap((f, fi) => f.passages.map((_, pi) => ({ fi, pi })))
  const perRequest = Math.max(1, Math.floor(FIND.sketchStateBytes / FIND.sketchBytes))
  const sketched: { fi: number; pi: number; score: number }[] = []
  await dispatch(
    chunks(cards, perRequest).map((batch) => ({
      batch,
      request: j.questions.sketchBatch(
        query,
        batch.map(({ fi, pi }) => ({
          fileKey: `f${fi}`,
          rel: files[fi]?.entry.rel ?? '',
          sketch: j.passages.sketch(files[fi]?.passages[pi] as Passage, words, weights, FIND.sketchBytes),
        })),
      ),
    })),
    (job, o) => {
      // A failed judgment is unknown, never grounds for leaving a passage out.
      for (const [k, { fi, pi }] of job.batch.entries())
        sketched.push({ fi, pi, score: noul(o, j.questions.passageKey(k)) ?? 1 })
    },
  )
  const survivors = sketched
    .filter((s) => s.score >= FIND.cutoff)
    .sort((a, b) => b.score - a.score || a.fi - b.fi || a.pi - b.pi)
    .slice(0, FIND.verified)
  const chosen = new Map<number, number[]>()
  for (const s of survivors) chosen.set(s.fi, [...(chosen.get(s.fi) ?? []), s.pi])
  const jobs = [...chosen.entries()].flatMap(([fi, ps]) =>
    chunks(
      ps.sort((a, b) => a - b),
      Math.max(1, Math.floor(FIND.verifyStateBytes / FIND.windowBytes)),
    ).map((group) => {
      const passages = group.map((pi) => files[fi]?.passages[pi] as Passage)
      return { fi, passages, request: j.questions.passageBatch(query, files[fi]?.entry.rel ?? '', passages) }
    }),
  )
  const results = new Map<number, { score: number; heat: HeatRange[]; lines: number }>()
  await dispatch(jobs, (job, o) => {
    if (!o.ok) return
    const entry = results.get(job.fi) ?? { score: 0, heat: [], lines: 0 }
    results.set(job.fi, entry)
    job.passages.forEach((passage, k) => {
      const p = noul(o, j.questions.passageKey(k))
      if (p === undefined) return
      const text = j.passages.plainContent(passage)
      entry.score = Math.max(entry.score, p)
      entry.heat.push({
        start: passage.start,
        end: passage.end,
        p,
        snippet: j.text.takeChars(j.text.lines(text).find((l) => l.trim()) ?? '', 100),
      })
      entry.lines += passage.end - passage.start + 1
    })
  })
  return [...results.entries()].flatMap(([fi, r]) => {
    const f = files[fi]
    if (!f || r.score < FIND.threshold) return []
    return [
      {
        rel: f.entry.path,
        score: r.score,
        ranges: j.passages.mergeHeat(r.heat, FIND.threshold),
        lines: r.lines,
        partial: f.truncated || r.lines < f.total,
      },
    ]
  })
}

/**
 * Without a judge: files by their words (omp's lexical prior), each with its passages by words; files are scored
 * against the strongest file and passages against the strongest passage, so neither reads as a probability.
 */
function wordHits(
  j: Jfind,
  files: readonly { entry: Entry; lex: number; passages: Passage[]; total: number; truncated: boolean }[],
  shown: (p: string) => string,
): Hit[] {
  const top = Math.max(0, ...files.flatMap((f) => f.passages.map((p) => p.score)))
  const best = Math.max(0, ...files.map((f) => f.lex))
  if (top <= 0 || best <= 0) return []
  return files
    .filter((f) => f.lex > 0)
    .sort((a, b) => b.lex - a.lex)
    .flatMap((f) => {
      const ranges = f.passages
        .filter((p) => p.score > 0)
        .map((p) => ({
          start: p.start,
          end: p.end,
          p: p.score / top,
          snippet: j.text.takeChars(
            j.text.lines(j.passages.plainContent(p)).find((l) => l.trim()) ?? '',
            100,
          ),
        }))
      if (ranges.length === 0) return []
      const lines = f.passages.reduce((n, p) => n + p.end - p.start + 1, 0)
      return [
        {
          rel: shown(f.entry.path),
          score: f.lex / best,
          ranges,
          lines,
          partial: f.truncated || lines < f.total,
        },
      ]
    })
}

/** omp's budget for a judge's keyword reply, room enough after a reasoning preamble a backend may still emit. */
const JUDGE_MAX_TOKENS = 4096

/**
 * A judge over one of the person's chat models (omp's chat text backend): temperature 0, no reasoning, and every
 * request through `hideInContext`, since passages are the agent's files and may hold secrets.
 */
export function chatJudge(resolver: ModelResolver, ref: string): Judge {
  const resolved = resolver.resolve(ref)
  const model = resolved.model as Model<Api>
  const backend: TextBackend = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    parseRetries: 2,
    async complete(prompt, options) {
      const apiKey = await resolver.requireApiKey(model)
      const context = hideInContext({
        systemPrompt: [prompt.system],
        messages: [{ role: 'user' as const, content: prompt.user, timestamp: Date.now() }],
      })
      const opts = {
        apiKey,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        disableReasoning: true,
        ...(options.signal ? { signal: options.signal } : {}),
      }
      const reply = resolved.streamFn
        ? await (await resolved.streamFn(model, context, opts)).result()
        : await completeSimple(model, context, opts)
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
        throw new Error(reply.errorMessage ?? 'the judge model failed')
      return {
        text: reply.content
          .flatMap((c) => (c.type === 'text' ? [c.text] : []))
          .join(' ')
          .trim(),
        usage: reply.usage,
      }
    },
  }
  return new TextJudge(backend)
}
