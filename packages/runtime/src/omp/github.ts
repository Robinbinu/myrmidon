/** omp's GitHub tool pieces: the shapes `gh` answers in, and its search, view and run-watch formatting. */
export type {
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
} from '@oh-my-pi/pi-coding-agent/tools/gh-types'

/** Loaded on first use: they pull in a good part of omp, which most rounds never need. */
export async function loadGithub() {
  const [common, search, view, watch] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/tools/gh-common'),
    import('@oh-my-pi/pi-coding-agent/tools/gh-search'),
    import('@oh-my-pi/pi-coding-agent/tools/gh-view'),
    import('@oh-my-pi/pi-coding-agent/tools/gh-run-watch'),
  ])
  return { common, search, view, watch }
}
export type Github = Awaited<ReturnType<typeof loadGithub>>
