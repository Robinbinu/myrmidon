/** Unified-diff parsing for the diff views: files, hunks, and lines with their old/new line numbers. */

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del'
  readonly text: string
  readonly old?: number
  readonly new?: number
}

export interface Hunk {
  readonly header: string
  readonly lines: DiffLine[]
}

/** One file's hunks, keyed by its new path; binary files and pure renames have none. */
export function parseFilePatch(text: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  let oldNo = 0
  let newNo = 0
  const all = text.split('\n')
  // A patch ends with a newline, so its last "line" is empty and not part of any hunk.
  if (all.at(-1) === '') all.pop()
  for (const line of all) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current || line.startsWith('\\')) continue
    if (line.startsWith('+')) current.lines.push({ kind: 'add', text: line.slice(1), new: newNo++ })
    else if (line.startsWith('-')) current.lines.push({ kind: 'del', text: line.slice(1), old: oldNo++ })
    else if (line.startsWith(' ') || line === '')
      current.lines.push({ kind: 'context', text: line.slice(1), old: oldNo++, new: newNo++ })
  }
  return hunks
}

/** Splits a multi-file unified diff into per-file sections, keyed by the file's new path. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part)
    if (header?.[2]) out.set(header[2], part)
  }
  return out
}

export interface SplitRow {
  readonly left?: DiffLine
  readonly right?: DiffLine
}

/** Side-by-side rows: context on both sides, a run of deletions paired with the run of additions after it. */
export function sideBySide(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as DiffLine
    if (line.kind === 'context') {
      rows.push({ left: line, right: line })
      i += 1
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (lines[i]?.kind === 'del') dels.push(lines[i++] as DiffLine)
    while (lines[i]?.kind === 'add') adds.push(lines[i++] as DiffLine)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({ ...(dels[k] ? { left: dels[k] } : {}), ...(adds[k] ? { right: adds[k] } : {}) })
  }
  return rows
}

export interface TreeNode {
  readonly name: string
  readonly path: string
  readonly children: TreeNode[]
  /** Set on files. */
  readonly file?: string
}

/** Files as a folder tree, with single-child folder chains collapsed into one row ("src/client/chat"). */
export function fileTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const path of paths) {
    let node = root
    const parts = path.split('/')
    parts.forEach((part, i) => {
      const at = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.name === part && !c.file === i < parts.length - 1)
      if (!child) {
        child = { name: part, path: at, children: [], ...(i === parts.length - 1 ? { file: path } : {}) }
        node.children.push(child)
      }
      node = child
    })
  }
  const squash = (n: TreeNode): TreeNode => {
    let node = n
    while (!node.file && node.children.length === 1 && !node.children[0]?.file) {
      const only = node.children[0] as TreeNode
      node = { ...only, name: node.name ? `${node.name}/${only.name}` : only.name }
    }
    return { ...node, children: sorted(node.children.map(squash)) }
  }
  const sorted = (nodes: TreeNode[]) =>
    nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name))
  return sorted(root.children.map(squash))
}
