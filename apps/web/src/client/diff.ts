export interface DiffLine {
  readonly kind: 'same' | 'add' | 'del'
  readonly text: string
}

const MAX_CELLS = 4_000_000

/** Line diff by longest common subsequence; falls back to a full replace for very large inputs. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array
    const next = dp[i + 1] as Uint32Array
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0))
      out.push({ kind: 'del', text: a[i++] as string })
    else out.push({ kind: 'add', text: b[j++] as string })
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] as string })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] as string })
  return out
}
