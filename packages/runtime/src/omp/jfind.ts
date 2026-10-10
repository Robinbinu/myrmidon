/**
 * The pieces of omp's semantic `find` (pi-coding-agent tools/jfind): query keywords, the lexical prior, passages,
 * the judge's request shapes, text helpers and the file tree. Loaded on first use, because questions.ts pulls in
 * omp's URL router, which no round needs at startup.
 */
export async function loadJfind() {
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
export type Jfind = Awaited<ReturnType<typeof loadJfind>>
