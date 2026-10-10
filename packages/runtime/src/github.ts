import { GITHUB } from './config.ts'
import type {
  GhActionsJobsResponse,
  GhActionsRunApi,
  GhApiSearchCodeItem,
  GhApiSearchCommitItem,
  GhApiSearchIssueItem,
  GhApiSearchRepoItem,
  GhApiSearchResponse,
  GhIssueViewData,
  GhPrViewData,
  GhRepoViewData,
} from './omp/github.ts'
import { type Github, loadGithub } from './omp/github.ts'
import { prompts } from './prompts.ts'
import type { ShellSyntax } from './shell.ts'

/**
 * GitHub for agents through the GitHub CLI, after omp's github tool (pi-coding-agent/src/tools/gh*.ts): its argument
 * building (JSON field lists, search qualifiers, Actions API paths) and its output shaping (repo, issue, pull request,
 * search and run summaries) are used as a library; omp's own runner is not, since it spawns `gh` as the person. Here
 * every `gh` call goes through a scope (tools.ts), which runs it where the agent's commands run and decides it with
 * the permission model first, like code-intel.ts. Nothing here knows the colony.
 */

const say = prompts.github

export const GITHUB_READS = [
  'repo_view',
  'issue_view',
  'issue_list',
  'pr_view',
  'pr_list',
  'pr_diff',
  'pr_checks',
  'search_issues',
  'search_prs',
  'search_code',
  'search_commits',
  'search_repos',
  'run_list',
  'run_view',
  'run_watch',
] as const
/** Operations that change something on GitHub: each one asks the person, whatever the preset. */
export const GITHUB_WRITES = [
  'issue_create',
  'issue_comment',
  'issue_close',
  'pr_create',
  'pr_comment',
  'pr_review',
  'pr_merge',
  'pr_close',
  'run_rerun',
] as const
export const GITHUB_OPS = [...GITHUB_READS, ...GITHUB_WRITES] as const
export type GithubOp = (typeof GITHUB_OPS)[number]

export interface GithubArgs {
  readonly op: GithubOp
  readonly repo?: string
  readonly issue?: string
  readonly pr?: string
  readonly run?: string
  readonly branch?: string
  readonly state?: 'open' | 'closed' | 'merged' | 'all'
  readonly label?: readonly string[]
  readonly assignee?: readonly string[]
  readonly reviewer?: readonly string[]
  readonly limit?: number
  readonly query?: string
  readonly since?: string
  readonly until?: string
  readonly dateField?: 'created' | 'updated'
  readonly comments?: boolean
  readonly title?: string
  readonly body?: string
  readonly base?: string
  readonly head?: string
  readonly draft?: boolean
  readonly method?: 'merge' | 'squash' | 'rebase'
  readonly event?: 'approve' | 'request_changes' | 'comment'
  readonly reason?: 'completed' | 'not planned'
  readonly failedOnly?: boolean
  readonly tail?: number
}

const WRITES: ReadonlySet<string> = new Set(GITHUB_WRITES)
export const githubWrites = (args: { op?: unknown }): boolean => WRITES.has(String(args.op))

/** What one `gh` call gave back. */
export interface GhResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** How the tool reaches `gh`: tools.ts runs it in the agent's sandbox after the permission model allowed the call. */
export interface GhScope {
  run(args: readonly string[], timeoutMs?: number): Promise<GhResult>
}

/**
 * POSIX quoting for the command line a call is shown and decided as (and run as, by `sh`): what a card shows and a
 * command rule matches is exactly what runs.
 */
export function posixLine(argv: readonly string[]): string {
  return argv.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(' ')
}

/** The command line that runs `argv` in a shell of this syntax (the sandbox's sh, or the host's shell unconfined). */
export function shellLine(argv: readonly string[], syntax: ShellSyntax): string {
  if (syntax === 'posix') return posixLine(argv)
  if (syntax === 'powershell') return `& ${argv.map((w) => `'${w.replaceAll("'", "''")}'`).join(' ')}`
  return argv.map((w) => `"${w.replaceAll('"', '""')}"`).join(' ')
}

/**
 * The person's gh, found on Myrmidon's own PATH as it is now (Bun.which alone may read the PATH it started with): the
 * sandbox's PATH leaves out most of the folders gh lives in.
 */
export function ghBinary(): string | undefined {
  return Bun.which('gh', { PATH: process.env.PATH ?? '' }) ?? undefined
}

/** gh never prompts (nothing could answer), never checks for updates, and writes plain text. */
const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  GIT_TERMINAL_PROMPT: '0',
}

let kept: { bin: string; token: string; at: number } | undefined

/**
 * The person's GitHub token from their own gh sign-in, asked outside the sandbox, which hides their gh config and
 * keychain from the commands it runs. It only ever goes into gh's environment, and every output is scrubbed of it
 * (`scrubToken`), so the agent never sees it.
 */
export async function ghToken(bin: string): Promise<string> {
  if (kept && kept.bin === bin && Date.now() - kept.at < GITHUB.tokenMs) return kept.token
  const proc = Bun.spawn([bin, 'auth', 'token'], {
    env: { ...process.env, ...GH_ENV },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: GITHUB.commandMs,
    windowsHide: true,
  })
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const token = out.trim()
  if (code !== 0 || !token) throw new Error(say.signedOut)
  kept = { bin, token, at: Date.now() }
  return token
}

/** Forgets the kept token (tests, or after the person signs in again). */
export function forgetGhToken(): void {
  kept = undefined
}

/** gh's environment where the agent's commands run: with the person's token when it cannot read their sign-in. */
export function ghEnv(token: string | undefined): Record<string, string> {
  const host = process.env.GH_HOST
  return { ...GH_ENV, ...(token ? { GH_TOKEN: token } : {}), ...(host ? { GH_HOST: host } : {}) }
}

/** Output with the token taken out, should gh or the API ever echo it. */
export function scrubToken(text: string, token: string | undefined): string {
  return token ? text.replaceAll(token, say.tokenHidden) : text
}

type Watch = Github['watch']
type RunSnapshot = ReturnType<Watch['normalizeRunSnapshot']>
type FailedJobLog = Parameters<Watch['formatRunWatchResult']>[2][number]

/**
 * An argument the agent wrote that `gh` takes as a word of its own (a number, URL, branch or repo): never empty, never
 * a flag, so `--repo=--web` or a pr of `--admin` cannot slip an option in. Free text goes as `--flag=value` instead.
 */
function word(value: string | undefined, name: string): string {
  const v = value?.trim() ?? ''
  if (!v) throw new Error(say.needs(name))
  if (v.startsWith('-') || /\s/.test(v)) throw new Error(say.badWord(name, v))
  return v
}

const optionalWord = (value: string | undefined, name: string) =>
  value?.trim() ? word(value, name) : undefined

/** `--name=value` for a word given, nothing for one left out. */
const flag = (name: string, value: string | undefined) => {
  const v = optionalWord(value, name)
  return v ? [`--${name}=${v}`] : []
}
const repoFlag = (repo: string | undefined) => flag('repo', repo)

const many = (flag: string, values: readonly string[] | undefined) =>
  (values ?? []).map((v) => `--${flag}=${word(v, flag)}`)

function listLimit(limit: number | undefined): number {
  if (limit === undefined) return GITHUB.listLimit
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(say.badLimit)
  return Math.min(Math.floor(limit), GITHUB.listMax)
}

/** The one `gh` command a write runs: what the person approves is this, with their edits to its text put back. */
export function githubWriteCommand(a: GithubArgs): string[] {
  const repo = repoFlag(a.repo)
  const body = a.body ?? ''
  switch (a.op) {
    case 'issue_create':
      return [
        'issue',
        'create',
        ...repo,
        `--title=${requireText(a.title, 'title')}`,
        `--body=${body}`,
        ...many('label', a.label),
        ...many('assignee', a.assignee),
      ]
    case 'issue_comment':
      return ['issue', 'comment', word(a.issue, 'issue'), ...repo, `--body=${requireText(a.body, 'body')}`]
    case 'issue_close':
      return [
        'issue',
        'close',
        word(a.issue, 'issue'),
        ...repo,
        ...(a.body?.trim() ? [`--comment=${a.body}`] : []),
        ...(a.reason ? [`--reason=${a.reason}`] : []),
      ]
    case 'pr_create':
      return [
        'pr',
        'create',
        ...repo,
        `--title=${requireText(a.title, 'title')}`,
        `--body=${body}`,
        ...flag('base', a.base),
        ...flag('head', a.head),
        ...(a.draft ? ['--draft'] : []),
        ...many('label', a.label),
        ...many('assignee', a.assignee),
        ...many('reviewer', a.reviewer),
      ]
    case 'pr_comment':
      return ['pr', 'comment', word(a.pr, 'pr'), ...repo, `--body=${requireText(a.body, 'body')}`]
    case 'pr_review': {
      const event = a.event ?? 'comment'
      // GitHub refuses a comment or a request for changes without words.
      const text =
        event !== 'approve'
          ? [`--body=${requireText(a.body, 'body')}`]
          : a.body?.trim()
            ? [`--body=${a.body}`]
            : []
      return ['pr', 'review', word(a.pr, 'pr'), ...repo, `--${event.replace('_', '-')}`, ...text]
    }
    case 'pr_merge':
      // gh asks how to merge unless told, and nothing here can answer a prompt.
      return ['pr', 'merge', word(a.pr, 'pr'), ...repo, `--${a.method ?? 'merge'}`]
    case 'pr_close':
      return ['pr', 'close', word(a.pr, 'pr'), ...repo, ...(a.body?.trim() ? [`--comment=${a.body}`] : [])]
    case 'run_rerun':
      return ['run', 'rerun', word(a.run, 'run'), ...repo, ...(a.failedOnly ? ['--failed'] : [])]
    default:
      throw new Error(say.notWrite(a.op))
  }
}

function requireText(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(say.needs(name))
  return value
}

/** gh's own failure, said plainly: not signed in, no repository here, or what gh said. */
function failure(r: GhResult, repoGiven: boolean): Error {
  if (r.timedOut) return new Error(say.timedOut(Math.round(GITHUB.commandMs / 1000)))
  const message = (r.stderr || r.stdout).trim()
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(message))
    return new Error(say.signedOut)
  if (
    !repoGiven &&
    /not a git repository|no git remotes found|unable to determine current repository/i.test(message)
  )
    return new Error(say.noRepo)
  return new Error(message || say.failed(r.code))
}

/** Runs an approved write: gh prints what it made or changed (usually its URL). */
export async function runGithubWrite(scope: GhScope, a: GithubArgs): Promise<string> {
  const r = await scope.run(githubWriteCommand(a))
  if (r.timedOut || r.code !== 0) throw failure(r, !!a.repo?.trim())
  return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n') || say.done(a.op)
}

async function text(
  scope: GhScope,
  args: readonly string[],
  repoGiven: boolean,
  ok: readonly number[] = [0],
) {
  const r = await scope.run(args)
  if (r.timedOut || !ok.includes(r.code ?? -1)) throw failure(r, repoGiven)
  return r.stdout
}

async function json<T>(scope: GhScope, args: readonly string[], repoGiven: boolean, ok?: readonly number[]) {
  const out = (await text(scope, args, repoGiven, ok)).trim()
  if (!out) throw new Error(say.empty)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(say.notJson)
  }
}

/** The checkout's own repository as `[host/]owner/repo`, the way omp asks gh for it; undefined outside one. */
async function currentRepo(scope: GhScope): Promise<string | undefined> {
  const { common } = await loadGithub()
  try {
    return common.repoFromUrl(await text(scope, ['repo', 'view', '--json', 'url', '-q', '.url'], false))
  } catch {
    return undefined
  }
}

type Line = readonly [label: string, value: string | number | boolean | null | undefined]

/** `- head` then its `  Label: value` lines, empty values left out, as omp's search results read. */
function item(head: string, lines: readonly Line[]): string {
  return [
    `- ${head}`,
    ...lines.flatMap(([k, v]) => (v === undefined || v === null || v === '' ? [] : [`  ${k}: ${v}`])),
  ].join('\n')
}

interface ListedIssue {
  number?: number
  title?: string
  state?: string
  author?: { login?: string } | null
  labels?: { name?: string }[]
  updatedAt?: string
  url?: string
  headRefName?: string
  baseRefName?: string
  isDraft?: boolean
}

interface ListedRun {
  databaseId?: number
  displayTitle?: string
  workflowName?: string
  status?: string
  conclusion?: string
  headBranch?: string
  event?: string
  createdAt?: string
  url?: string
}

interface Check {
  name?: string
  state?: string
  bucket?: string
  workflow?: string
  link?: string
  description?: string
}

const labels = (l: ListedIssue['labels']) => l?.flatMap((x) => (x.name ? [x.name] : [])).join(', ')

/** Runs one operation and returns what the agent reads. Writes are approved by the caller before this runs them. */
export async function runGithub(scope: GhScope, a: GithubArgs): Promise<string> {
  const { common, search, view } = await loadGithub()
  const given = !!a.repo?.trim()
  const repo = repoFlag(a.repo)
  switch (a.op) {
    case 'repo_view': {
      const r = optionalWord(a.repo, 'repo')
      const branch = optionalWord(a.branch, 'branch')
      const data = await json<GhRepoViewData>(
        scope,
        [
          'repo',
          'view',
          ...(r ? [r] : []),
          ...(branch ? [`--branch=${branch}`] : []),
          '--json',
          view.GH_REPO_FIELDS.join(','),
        ],
        given,
      )
      return view.formatRepoView(data, { ...(r ? { repo: r } : {}), ...(branch ? { branch } : {}) })
    }
    case 'issue_view': {
      const issue = word(a.issue, 'issue')
      const comments = a.comments ?? true
      const fields = comments ? view.GH_ISSUE_FIELDS : view.GH_ISSUE_FIELDS_NO_COMMENTS
      const args = ['issue', 'view', issue, ...repo, '--json', fields.join(',')]
      let data: GhIssueViewData
      try {
        data = await json<GhIssueViewData>(scope, args, given)
      } catch (err) {
        // Older gh releases do not know stateReason; omp asks again without it.
        const retry = view.ghJsonErrorNamesField(err, view.GH_ISSUE_STATE_REASON_FIELD)
          ? view.dropJsonField(args, view.GH_ISSUE_STATE_REASON_FIELD)
          : undefined
        if (!retry) throw err
        data = await json<GhIssueViewData>(scope, retry, given)
      }
      return view.formatIssueView(data, { issue, ...(given ? { repo: a.repo } : {}), comments })
    }
    case 'pr_view': {
      const pr = optionalWord(a.pr, 'pr')
      const comments = a.comments ?? true
      const fields = comments ? view.GH_PR_FIELDS : view.GH_PR_FIELDS_NO_COMMENTS
      const data = await json<GhPrViewData>(
        scope,
        ['pr', 'view', ...(pr ? [pr] : []), ...repo, '--json', fields.join(',')],
        given,
      )
      return view.formatPrView(data, { ...(pr ? { pr } : {}), ...(given ? { repo: a.repo } : {}), comments })
    }
    case 'issue_list':
    case 'pr_list': {
      const pr = a.op === 'pr_list'
      const state = a.state ?? 'open'
      if (!pr && state === 'merged') throw new Error(say.issuesNotMerged)
      const fields = ['number', 'title', 'state', 'author', 'labels', 'updatedAt', 'url']
      if (pr) fields.push('headRefName', 'baseRefName', 'isDraft')
      const query = a.query?.trim()
      const items = await json<ListedIssue[]>(
        scope,
        [
          pr ? 'pr' : 'issue',
          'list',
          ...repo,
          `--state=${state}`,
          `--limit=${listLimit(a.limit)}`,
          ...many('label', a.label),
          ...(query ? [`--search=${query}`] : []),
          ...(pr ? [...flag('base', a.base), ...flag('head', a.head)] : []),
          '--json',
          fields.join(','),
        ],
        given,
      )
      const kind = pr ? 'pull requests' : 'issues'
      if (items.length === 0) return say.noneListed(kind, state)
      return [
        say.listed(items.length, kind, state),
        ...items.map((i) =>
          item(`#${i.number ?? '?'} ${i.title ?? 'Untitled'}`, [
            ['State', i.isDraft ? `${i.state} (draft)` : i.state],
            ['Author', i.author?.login ? `@${i.author.login}` : undefined],
            ['Branch', pr ? `${i.headRefName ?? '?'} → ${i.baseRefName ?? '?'}` : undefined],
            ['Labels', labels(i.labels)],
            ['Updated', i.updatedAt],
            ['URL', i.url],
          ]),
        ),
      ].join('\n\n')
    }
    case 'pr_diff': {
      const pr = word(a.pr, 'pr')
      const diff = await text(scope, ['pr', 'diff', pr, ...repo, '--color=never'], given)
      return diff.trim() ? diff : say.emptyDiff(pr)
    }
    case 'pr_checks': {
      const pr = word(a.pr, 'pr')
      // gh exits 8 while checks are pending and 1 when one failed; the JSON is the answer either way.
      const checks = await json<Check[]>(
        scope,
        ['pr', 'checks', pr, ...repo, '--json', 'name,state,bucket,workflow,link,description'],
        given,
        [0, 1, 8],
      )
      if (checks.length === 0) return say.noChecks(pr)
      return [
        say.checks(pr, checks.length),
        ...checks.map((c) =>
          item(`${c.name ?? '(unnamed)'}: ${c.bucket ?? c.state ?? '?'}`, [
            ['Workflow', c.workflow],
            ['Detail', c.description],
            ['URL', c.link],
          ]),
        ),
      ].join('\n\n')
    }
    case 'search_issues':
    case 'search_prs':
    case 'search_commits': {
      const kind = a.op === 'search_issues' ? 'issues' : a.op === 'search_prs' ? 'prs' : 'commits'
      const limit = search.resolveSearchLimit(a.limit)
      const field = search.resolveSearchDateField(kind, a.dateField)
      const shown = search.composeSearchQuery([
        a.query,
        search.buildSearchDateQualifier(field, a.since, a.until),
      ])
      const scoped = await searchScope(scope, a.repo, shown)
      const ref = scoped ? common.parseRepoRef(scoped) : undefined
      const qualifier = kind === 'issues' ? 'is:issue' : kind === 'prs' ? 'is:pr' : undefined
      const query = search.composeSearchQuery([shown, ref ? `repo:${ref.slug}` : undefined, qualifier])
      const endpoint = kind === 'commits' ? 'commits' : 'issues'
      const args = search.buildGhApiSearchArgs(endpoint, query, limit, ref?.host ? { host: ref.host } : {})
      if (kind === 'commits') {
        const res = await json<GhApiSearchResponse<GhApiSearchCommitItem>>(scope, args, true)
        return search.formatSearchCommitsResults(
          shown,
          scoped,
          (res.items ?? []).map(search.apiCommitToSearchResult),
        )
      }
      const res = await json<GhApiSearchResponse<GhApiSearchIssueItem>>(scope, args, true)
      return search.formatSearchResults(
        kind === 'issues' ? 'issues' : 'pull requests',
        shown,
        scoped,
        (res.items ?? []).map(search.apiIssueToSearchResult),
      )
    }
    case 'search_code': {
      const query = requireText(a.query, 'query')
      // GitHub's code search has no date qualifier.
      if (a.since?.trim() || a.until?.trim()) throw new Error(say.codeNoDates)
      const scoped = await searchScope(scope, a.repo, query)
      const ref = scoped ? common.parseRepoRef(scoped) : undefined
      const args = search.buildGhApiSearchArgs(
        'code',
        search.composeSearchQuery([query, ref ? `repo:${ref.slug}` : undefined]),
        search.resolveSearchLimit(a.limit),
        {
          ...(ref?.host ? { host: ref.host } : {}),
          extraHeaders: ['Accept: application/vnd.github.text-match+json'],
        },
      )
      const res = await json<GhApiSearchResponse<GhApiSearchCodeItem>>(scope, args, true)
      return search.formatSearchCodeResults(
        query,
        scoped,
        (res.items ?? []).map(search.apiCodeToSearchResult),
      )
    }
    case 'search_repos': {
      const query = search.composeSearchQuery([
        a.query,
        search.buildSearchDateQualifier(
          search.resolveSearchDateField('repos', a.dateField),
          a.since,
          a.until,
        ),
      ])
      const args = search.buildGhApiSearchArgs('repositories', query, search.resolveSearchLimit(a.limit))
      const res = await json<GhApiSearchResponse<GhApiSearchRepoItem>>(scope, args, true)
      return search.formatSearchReposResults(query, (res.items ?? []).map(search.apiRepoToSearchResult))
    }
    case 'run_list': {
      const branch = optionalWord(a.branch, 'branch')
      const runs = await json<ListedRun[]>(
        scope,
        [
          'run',
          'list',
          ...repo,
          ...(branch ? [`--branch=${branch}`] : []),
          `--limit=${listLimit(a.limit)}`,
          '--json',
          'databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url',
        ],
        given,
      )
      if (runs.length === 0) return say.noRuns
      return [
        say.runs(runs.length),
        ...runs.map((r) =>
          item(`${r.databaseId ?? '?'} ${r.workflowName ?? ''}: ${r.displayTitle ?? ''}`.trim(), [
            ['Status', r.conclusion ? `${r.status} (${r.conclusion})` : r.status],
            ['Branch', r.headBranch],
            ['Event', r.event],
            ['Created', r.createdAt],
            ['URL', r.url],
          ]),
        ),
      ].join('\n\n')
    }
    case 'run_view':
    case 'run_watch':
      return runReport(scope, a)
    default:
      throw new Error(say.notRead(a.op))
  }
}

/**
 * omp's search scope: the repo given; none when the query already names one (`repo:`, `org:`, `user:`); else the
 * checkout's own, and all of GitHub when there is none.
 */
async function searchScope(scope: GhScope, repo: string | undefined, query: string) {
  const { search } = await loadGithub()
  const given = optionalWord(repo, 'repo')
  if (given) return given
  if (search.REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined
  return currentRepo(scope)
}

/** The repository a run belongs to: from its URL, the repo given (which must agree), or the checkout's. */
async function runRepo(scope: GhScope, given: string | undefined, fromUrl: string | undefined) {
  const { common } = await loadGithub()
  const repo = optionalWord(given, 'repo')
  if (repo && fromUrl && !common.githubRepoSlugEquals(repo, fromUrl)) throw new Error(say.runRepoMismatch)
  const found = repo ?? fromUrl ?? (await currentRepo(scope))
  if (!found) throw new Error(say.noRepo)
  return found
}

/** A run and its jobs through the Actions API, as omp's fetchRunSnapshot reads them. */
async function snapshot(scope: GhScope, repo: string, id: number): Promise<RunSnapshot> {
  const { common, watch } = await loadGithub()
  const ref = common.parseRepoRef(repo)
  const host = common.ghApiHostArgs(ref)
  const run = await json<GhActionsRunApi>(
    scope,
    ['api', ...host, '--method', 'GET', `/repos/${ref.slug}/actions/runs/${id}`],
    true,
  )
  const jobs: NonNullable<ReturnType<Watch['normalizeRunJob']>>[] = []
  for (let page = 1; ; page++) {
    const res = await json<GhActionsJobsResponse>(
      scope,
      [
        'api',
        ...host,
        '--method',
        'GET',
        `/repos/${ref.slug}/actions/runs/${id}/jobs`,
        '-F',
        `per_page=${watch.RUN_JOBS_PAGE_SIZE}`,
        '-F',
        `page=${page}`,
      ],
      true,
    )
    const raw = res.jobs ?? []
    for (const job of raw) {
      const j = watch.normalizeRunJob(job)
      if (j) jobs.push(j)
    }
    if (raw.length < watch.RUN_JOBS_PAGE_SIZE || (res.total_count ?? 0) <= jobs.length) break
  }
  return watch.normalizeRunSnapshot(run, jobs)
}

/** The end of each failed job's log, as omp's fetchFailedJobLogs keeps it. */
async function failedLogs(
  scope: GhScope,
  repo: string,
  run: RunSnapshot,
  tail: number,
): Promise<FailedJobLog[]> {
  const { common, watch } = await loadGithub()
  const ref = common.parseRepoRef(repo)
  return Promise.all(
    run.jobs.filter(watch.isFailedJob).map(async (job) => {
      const r = await scope.run([
        'api',
        ...common.ghApiHostArgs(ref),
        '--method',
        'GET',
        `/repos/${ref.slug}/actions/jobs/${job.id}/logs`,
      ])
      const full = r.code === 0 ? common.normalizeBlock(r.stdout) : undefined
      const end = full ? watch.tailLogLines(full, tail) : undefined
      return { run, job, full, tail: end, available: !!full }
    }),
  )
}

/**
 * run_view: a run with its jobs and the end of every failed job's log. run_watch: the same once the run is done, a
 * job failed (omp fails fast on the first), or the watch ran out of time, asking every GITHUB.pollMs meanwhile. With
 * no run named it watches the newest run (of `branch`, when given).
 */
async function runReport(scope: GhScope, a: GithubArgs): Promise<string> {
  const { watch } = await loadGithub()
  const tail = watch.resolveTailLimit(a.tail)
  let ref = watch.parseRunReference(a.run)
  if (ref.runId === undefined) {
    if (a.op === 'run_view') throw new Error(say.needs('run'))
    const branch = optionalWord(a.branch, 'branch')
    const newest = await json<{ databaseId?: number }[]>(
      scope,
      [
        'run',
        'list',
        ...repoFlag(a.repo),
        ...(branch ? [`--branch=${branch}`] : []),
        '--limit=1',
        '--json',
        'databaseId',
      ],
      !!a.repo?.trim(),
    )
    const id = newest[0]?.databaseId
    if (id === undefined) return say.noRuns
    ref = { ...ref, runId: id }
  }
  const repo = await runRepo(scope, a.repo, ref.repo)
  const id = ref.runId as number
  let run = await snapshot(scope, repo, id)
  if (a.op === 'run_watch') {
    const until = Date.now() + GITHUB.watchMs
    let polls = 1
    while (watch.getRunSnapshotOutcome(run) === 'pending' && !run.jobs.some(watch.isFailedJob)) {
      if (Date.now() + GITHUB.pollMs > until)
        return watch.formatRunWatchSnapshot(
          repo,
          run,
          polls,
          say.stillRunning(Math.round(GITHUB.watchMs / 60_000)),
        )
      await Bun.sleep(GITHUB.pollMs)
      run = await snapshot(scope, repo, id)
      polls++
    }
  }
  const logs = run.jobs.some(watch.isFailedJob) ? await failedLogs(scope, repo, run, tail) : []
  return watch.formatRunWatchResult(repo, run, logs, tail)
}
