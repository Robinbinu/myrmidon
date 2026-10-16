/**
 * Marks outside content so the model can tell data from instructions ("spotlighting"). The boundary is random per
 * round and removed from the content, so a page cannot close the block early and speak as the harness.
 */
export function spotlight(boundary: string, source: string, text: string): string {
  const clean = text.replace(/⟦\/?untrusted[^⟧]*⟧/g, '')
  return `⟦untrusted ${boundary} · ${source}⟧\n${clean}\n⟦/untrusted ${boundary}⟧`
}
