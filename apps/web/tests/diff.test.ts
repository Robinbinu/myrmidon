import { expect, test } from 'bun:test'
import { fileTree, parseFilePatch, sideBySide, splitPatch } from '../src/client/chat/diff.ts'

const PATCH = `diff --git a/src/math.ts b/src/math.ts
index 1..2 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@ export
 export const a = 1
-export const b = 2
+export const b = 3
+export const c = 4
 export const d = 5
diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+# hi
`

test('a patch splits into files, hunks, and numbered lines', () => {
  const files = splitPatch(PATCH)
  expect([...files.keys()]).toEqual(['src/math.ts', 'README.md'])
  const [hunk] = parseFilePatch(files.get('src/math.ts') ?? '')
  expect(hunk?.lines).toEqual([
    { kind: 'context', text: 'export const a = 1', old: 1, new: 1 },
    { kind: 'del', text: 'export const b = 2', old: 2 },
    { kind: 'add', text: 'export const b = 3', new: 2 },
    { kind: 'add', text: 'export const c = 4', new: 3 },
    { kind: 'context', text: 'export const d = 5', old: 3, new: 4 },
  ])
  expect(parseFilePatch(files.get('README.md') ?? '')[0]?.lines).toEqual([
    { kind: 'add', text: '# hi', new: 1 },
  ])
})

test('side by side pairs a deletion with the addition that replaced it', () => {
  const [hunk] = parseFilePatch(splitPatch(PATCH).get('src/math.ts') ?? '')
  const rows = sideBySide(hunk?.lines ?? [])
  expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
    ['export const a = 1', 'export const a = 1'],
    ['export const b = 2', 'export const b = 3'],
    [null, 'export const c = 4'],
    ['export const d = 5', 'export const d = 5'],
  ])
})

test('files form a folder tree with single-folder chains collapsed', () => {
  const tree = fileTree(['src/client/chat/a.ts', 'src/client/chat/b.ts', 'src/server.ts', 'README.md'])
  expect(tree.map((n) => n.name)).toEqual(['src', 'README.md'])
  const src = tree[0]
  expect(src?.children.map((n) => n.name)).toEqual(['client/chat', 'server.ts'])
  expect(src?.children[0]?.children.map((n) => n.file)).toEqual([
    'src/client/chat/a.ts',
    'src/client/chat/b.ts',
  ])
})
