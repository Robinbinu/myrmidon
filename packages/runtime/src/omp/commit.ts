/**
 * omp's commit workflow pieces (commit/): the dependency order of a split plan (agentic/topo-sort.ts) and its
 * summary and scope checks (analysis/validation.ts). Its agent, prompts and git runner are not used: Myrmidon's
 * agents propose the plan with their own tool (commit-split.ts).
 */
export function loadCommit() {
  return Promise.all([
    import('@oh-my-pi/pi-coding-agent/commit/agentic/topo-sort'),
    import('@oh-my-pi/pi-coding-agent/commit/analysis/validation'),
  ]).then(([topo, validation]) => ({ topo, validation }))
}
