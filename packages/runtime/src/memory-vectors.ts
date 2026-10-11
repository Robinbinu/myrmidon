import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { RECALL_MMR_LAMBDA, RECALL_QUERY_CHARS, RECALL_VECTORS } from './config.ts'
import { freshness, type Memory, type MemoryMeaning, wordScores } from './memory.ts'
import { cosineSimilarityPairs, mmrRerankIndices, vectorIndexTopK } from './omp/natives.ts'
import { hideSecrets } from './provider-secrets.ts'

/**
 * Memory recall by meaning, after omp's mnemopi: kept memories and the request are embedded by the model the person
 * picked (Settings → Memory), and ranked by cosine (omp's `vectorIndexTopK`) blended with the words they share and
 * their freshness, then reordered so near-duplicates do not crowd the top (`mmrRerankIndices`). Off until an embedding
 * model is picked, as embeddings are paid calls; word matching (memory.ts) stays the default and the fallback.
 * Vectors are kept in `<home>/memory-vectors.json`, one per memory and text, so a memory is embedded once.
 */

/** An embedding model as recall uses it: its ref, and one vector per text. */
export interface Embedder {
  readonly model: string
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
}

interface VectorFile {
  model: string
  /** By memory id: a hash of the text embedded, and the vector as base64 float32. */
  vectors: Record<string, { h: string; v: string }>
}

const hashOf = (text: string) => Bun.hash(text).toString(36)
const encode = (v: readonly number[]) => Buffer.from(new Float32Array(v).buffer).toString('base64')
const decode = (s: string) => {
  const bytes = Buffer.from(s, 'base64')
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

export class MemoryVectors {
  constructor(private readonly _file: string) {}

  private _read(model: string): VectorFile {
    if (!existsSync(this._file)) return { model, vectors: {} }
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as VectorFile
      // Another model's vectors do not compare with this one's.
      return raw?.model === model && raw.vectors && typeof raw.vectors === 'object'
        ? raw
        : { model, vectors: {} }
    } catch {
      return { model, vectors: {} }
    }
  }

  private _write(file: VectorFile) {
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, this._file)
  }

  /** The vectors already kept for `memories` by `model`, without calling it. */
  cached(memories: readonly Memory[], model: string): Map<string, Float32Array> {
    const file = this._read(model)
    const out = new Map<string, Float32Array>()
    for (const m of memories) {
      const row = file.vectors[m.id]
      if (row && row.h === hashOf(m.text)) out.set(m.id, decode(row.v))
    }
    return out
  }

  /**
   * Each memory's vector, embedding those not kept yet (new, or edited since). `known`: every memory id still stored,
   * so vectors of removed memories are dropped.
   */
  async vectors(
    memories: readonly Memory[],
    embedder: Embedder,
    known: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, Float32Array>> {
    const file = this._read(embedder.model)
    const missing = memories.filter((m) => file.vectors[m.id]?.h !== hashOf(m.text))
    for (let i = 0; i < missing.length; i += RECALL_VECTORS.batch) {
      const batch = missing.slice(i, i + RECALL_VECTORS.batch)
      // Like every prompt, what reaches the embedding provider has the person's secrets as placeholders.
      const got = await embedder.embed(
        batch.map((m) => hideSecrets(m.text)),
        signal,
      )
      batch.forEach((m, j) => {
        const v = got[j]
        if (v?.length) file.vectors[m.id] = { h: hashOf(m.text), v: encode(v) }
      })
    }
    const stale = Object.keys(file.vectors).filter((id) => !known.has(id))
    for (const id of stale) delete file.vectors[id]
    if (missing.length || stale.length) this._write(file)
    return this.cached(memories, embedder.model)
  }
}

/**
 * Memories ranked by meaning and words: cosine to the request (`query`), the words they share (BM25, as memory.ts
 * ranks) and freshness, weighed as RECALL_VECTORS says; a memory counts when it shares a word or is close enough in
 * meaning (`minCosine`). Then MMR, so near-duplicates do not crowd the top.
 */
export function rankByMeaning(
  memories: readonly Memory[],
  vectors: ReadonlyMap<string, Float32Array>,
  query: { text: string; vector: readonly number[] },
  limit: number,
  now = Date.now(),
): Memory[] {
  const rows = memories.filter((m) => vectors.has(m.id))
  if (!rows.length || limit <= 0 || !query.vector.some((x) => x !== 0)) return []
  const dims = Math.max(...rows.map((m) => vectors.get(m.id)?.length ?? 0))
  // vectorIndexTopK expects normalized rows.
  const matrix = new Float32Array(rows.length * dims)
  rows.forEach((m, r) => {
    const v = vectors.get(m.id) as Float32Array
    const norm = Math.hypot(...v) || 1
    for (let c = 0; c < v.length; c++) matrix[r * dims + c] = (v[c] ?? 0) / norm
  })
  const top = vectorIndexTopK(matrix, dims, Float64Array.from(query.vector), rows.length)
  const cosine = new Float64Array(rows.length)
  top.indices.forEach((row, i) => {
    cosine[row] = top.scores[i] ?? 0
  })
  const words = wordScores(rows, query.text)
  const best = Math.max(0, ...words)
  const scored = rows
    .map((m, i) => {
      const w = best > 0 ? (words[i] ?? 0) / best : 0
      const c = cosine[i] ?? 0
      return {
        m,
        hit: w > 0 || c >= RECALL_VECTORS.minCosine,
        score:
          RECALL_VECTORS.vector * c + RECALL_VECTORS.words * w + RECALL_VECTORS.freshness * freshness(m, now),
      }
    })
    .filter((s) => s.hit)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return []
  const picked = mmrRerankIndices(
    scored.map((s) => s.m.text.toLowerCase()),
    Float64Array.from(scored.map((s) => s.score)),
    RECALL_MMR_LAMBDA,
    Math.min(limit, scored.length),
  )
  return [...picked].flatMap((i) => (scored[i] ? [scored[i].m] : []))
}

/** Whether two memories of one scope are close enough in meaning (`overlapCosine`) that tidying up may merge them. */
export function lookAlike(memories: readonly Memory[], vectors: ReadonlyMap<string, Float32Array>): boolean {
  const scopes = new Map<string, Memory[]>()
  for (const m of memories)
    if (vectors.has(m.id)) scopes.set(m.project ?? '', [...(scopes.get(m.project ?? '') ?? []), m])
  for (const group of scopes.values()) {
    if (group.length < 2) continue
    const dims = Math.max(...group.map((m) => vectors.get(m.id)?.length ?? 0))
    const flat = new Float64Array(group.length * dims)
    group.forEach((m, r) => {
      const v = vectors.get(m.id) as Float32Array
      for (let c = 0; c < v.length; c++) flat[r * dims + c] = v[c] ?? 0
    })
    if (cosineSimilarityPairs(flat, group.length, dims, RECALL_VECTORS.overlapCosine).length) return true
  }
  return false
}

/** Recall by meaning for MemoryStore, with the embedding model the person picked, if any (`embedder`). */
export class MeaningRecall implements MemoryMeaning {
  private readonly _vectors: MemoryVectors

  constructor(
    file: string,
    private readonly _embedder: () => Embedder | undefined,
  ) {
    this._vectors = new MemoryVectors(file)
  }

  async rank(
    memories: readonly Memory[],
    query: string,
    limit: number,
    known: ReadonlySet<string>,
  ): Promise<Memory[] | undefined> {
    const embedder = this._embedder()
    if (!embedder) return undefined
    const signal = AbortSignal.timeout(RECALL_VECTORS.timeoutMs)
    const text = query.slice(0, RECALL_QUERY_CHARS)
    const [vectors, [vector]] = await Promise.all([
      this._vectors.vectors(memories, embedder, known, signal),
      embedder.embed([hideSecrets(text)], signal),
    ])
    if (!vector) throw new Error(`${embedder.model} returned no vector for the request`)
    return rankByMeaning(memories, vectors, { text, vector }, limit)
  }

  lookAlike(memories: readonly Memory[]): boolean {
    const embedder = this._embedder()
    return !!embedder && lookAlike(memories, this._vectors.cached(memories, embedder.model))
  }
}
