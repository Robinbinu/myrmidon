import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { READ_SQL_MAX_ROWS } from '../src/config.ts'
import { looksBinary, readFileAs } from '../src/file-read.ts'
import type { ColonyHost } from '../src/host.ts'
import { loadArchives } from '../src/omp/utils.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-file-read-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const { encodeArchive } = await loadArchives()
const at = (name: string) => join(dir, name)

/** A one-page PDF whose page says `words`, small enough to write by hand. */
function pdf(words: string): string {
  const stream = `BT /F1 24 Tf 72 700 Td (${words}) Tj ET`
  return [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream`,
    stream,
    'endstream',
    'endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n')
}

/** A solid grey RGB PNG of the given size. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, width)
  new DataView(ihdr.buffer).setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = 1 + width * 3
  const raw = new Uint8Array(height * row).fill(200)
  for (let y = 0; y < height; y++) raw[y * row] = 0
  return Buffer.concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ])
}

const DOCX: [string, string][] = [
  [
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ],
  [
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ],
  [
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p></w:body></w:document>',
  ],
]

test('a PDF reads as Markdown under a header naming its pages', async () => {
  writeFileSync(at('report.pdf'), pdf('Hello PDF'))
  const read = await readFileAs(at('report.pdf'), 'report.pdf')
  expect(read.text).toContain('Hello PDF')
  expect(read.head).toStartWith('report.pdf: PDF, 1 page, as Markdown.')
})

test('Word and Excel files read as Markdown through omp’s document engine', async () => {
  writeFileSync(at('plan.docx'), await encodeArchive('zip', DOCX))
  const docx = await readFileAs(at('plan.docx'), 'plan.docx')
  expect(docx).toEqual({ text: 'Quarterly plan', head: 'plan.docx: Word document, as Markdown.' })

  writeFileSync(
    at('budget.xlsx'),
    await encodeArchive('zip', [
      [
        'xl/workbook.xml',
        '<workbook xmlns:r="r"><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>',
      ],
      [
        'xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ],
      [
        'xl/worksheets/sheet1.xml',
        '<worksheet><sheetData><row><c t="inlineStr"><is><t>rent</t></is></c><c><v>1200</v></c></row></sheetData></worksheet>',
      ],
    ]),
  )
  const xlsx = await readFileAs(at('budget.xlsx'), 'budget.xlsx')
  expect(xlsx.head).toBe('budget.xlsx: Excel document, as Markdown.')
  expect(xlsx.text).toContain('## Budget')
  expect(xlsx.text).toContain('| rent | 1200 |')
})

test('a notebook reads as its cells', async () => {
  const notebook = {
    cells: [
      { cell_type: 'markdown', source: ['# Findings\n', 'Rates rose.'], metadata: {} },
      { cell_type: 'code', source: ['print(1 + 1)'], outputs: [], execution_count: 1, metadata: {} },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
  writeFileSync(at('analysis.ipynb'), JSON.stringify(notebook))
  const read = await readFileAs(at('analysis.ipynb'), 'analysis.ipynb')
  expect(read.text).toContain('# Findings\nRates rose.')
  expect(read.text).toContain('print(1 + 1)')
  expect(read.head).toStartWith('analysis.ipynb: Jupyter notebook')
})

test('an archive lists its files, and entry reads one of them, a document inside included', async () => {
  writeFileSync(
    at('bundle.zip'),
    await encodeArchive('zip', [
      ['README.md', '# Bundle\n'],
      ['src/main.ts', 'export const answer = 42\n'],
      ['docs/report.pdf', pdf('Inside the zip')],
      ['inner.zip', await encodeArchive('zip', [['a.txt', 'a']])],
    ]),
  )
  const list = await readFileAs(at('bundle.zip'), 'bundle.zip')
  expect(list.head).toBe('bundle.zip: zip archive of 4 files. fs_read with entry reads one of them.')
  expect(list.text.split('\n').map((l) => l.replace(/ \(.*\)$/, ''))).toEqual([
    'docs/report.pdf',
    'inner.zip',
    'README.md',
    'src/main.ts',
  ])

  expect(await readFileAs(at('bundle.zip'), 'bundle.zip', { entry: 'src/main.ts' })).toEqual({
    text: 'export const answer = 42\n',
  })
  const folder = await readFileAs(at('bundle.zip'), 'bundle.zip', { entry: 'src' })
  expect(folder.head).toBe('bundle.zip: folder src of the archive.')
  expect(folder.text).toStartWith('main.ts')
  const inner = await readFileAs(at('bundle.zip'), 'bundle.zip', { entry: 'docs/report.pdf' })
  expect(inner.text).toContain('Inside the zip')
  expect(inner.head).toStartWith('docs/report.pdf in bundle.zip: PDF, 1 page')

  await expect(readFileAs(at('bundle.zip'), 'bundle.zip', { entry: 'nope.txt' })).rejects.toThrow(
    'no nope.txt in bundle.zip',
  )
  await expect(readFileAs(at('bundle.zip'), 'bundle.zip', { entry: 'inner.zip' })).rejects.toThrow(
    'inner.zip is itself an archive or a database',
  )
})

test('a tar.gz archive reads the same way', async () => {
  writeFileSync(at('logs.tar.gz'), await encodeArchive('tar.gz', [['app/today.log', 'started\nstopped\n']]))
  const list = await readFileAs(at('logs.tar.gz'), 'logs.tar.gz')
  expect(list.head).toBe('logs.tar.gz: tar.gz archive of 1 file. fs_read with entry reads one of them.')
  expect(list.text).toStartWith('app/today.log')
  expect((await readFileAs(at('logs.tar.gz'), 'logs.tar.gz', { entry: 'app/today.log' })).text).toBe(
    'started\nstopped\n',
  )
})

test('a SQLite database lists its tables with their schema, and sql runs a reading query', async () => {
  const db = new Database(at('shop.db'))
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB)')
  db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)')
  db.run("INSERT INTO users (name, avatar) VALUES ('ada', x'0102'), ('grace', NULL)")
  const insert = db.query('INSERT INTO orders (total) VALUES (?)')
  for (let i = 0; i < READ_SQL_MAX_ROWS + 5; i++) insert.run(i)
  db.close()
  const before = readdirSync(dir).sort()

  const tables = await readFileAs(at('shop.db'), 'shop.db')
  expect(tables.head).toBe(
    'shop.db: SQLite database, 2 tables. fs_read with sql runs a read-only SELECT on it.',
  )
  expect(tables.text).toBe(
    `orders (${READ_SQL_MAX_ROWS + 5} rows)\nCREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)\n\n` +
      'users (2 rows)\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB)',
  )

  const users = await readFileAs(at('shop.db'), 'shop.db', { sql: 'SELECT * FROM users ORDER BY id' })
  expect(users).toEqual({
    text: '{"id":1,"name":"ada","avatar":"(2 bytes of binary)"}\n{"id":2,"name":"grace","avatar":null}',
    head: '2 rows, one JSON object per line.',
  })
  const orders = await readFileAs(at('shop.db'), 'shop.db', { sql: '-- every order\nSELECT id FROM orders' })
  expect(orders.text.split('\n')).toHaveLength(READ_SQL_MAX_ROWS)
  expect(orders.head).toContain('more rows match: add LIMIT and OFFSET')

  // Only reading statements run: ATTACH would reach files the read-access rules never checked.
  for (const sql of [
    `ATTACH '${at('other.db')}' AS other`,
    'DELETE FROM users',
    'PRAGMA writable_schema = 1',
  ])
    await expect(readFileAs(at('shop.db'), 'shop.db', { sql })).rejects.toThrow('must start with SELECT')
  await expect(
    readFileAs(at('shop.db'), 'shop.db', { sql: 'WITH x AS (SELECT 1) DELETE FROM users' }),
  ).rejects.toThrow()
  expect(readdirSync(dir).sort()).toEqual(before)
})

test('a WAL database whose sidecar files are gone still reads, and none are created beside it', async () => {
  const sub = mkdtempSync(join(dir, 'wal-'))
  const db = new Database(join(sub, 'app.sqlite'))
  db.run('PRAGMA journal_mode = WAL')
  db.run('CREATE TABLE notes (body TEXT)')
  db.run("INSERT INTO notes VALUES ('kept')")
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  // As a database copied without its sidecars arrives.
  for (const side of ['-wal', '-shm']) rmSync(join(sub, `app.sqlite${side}`), { force: true })
  expect(readdirSync(sub)).toEqual(['app.sqlite'])
  const read = await readFileAs(join(sub, 'app.sqlite'), 'app.sqlite', { sql: 'SELECT body FROM notes' })
  expect(read.text).toBe('{"body":"kept"}')
  expect(readdirSync(sub)).toEqual(['app.sqlite'])
})

test('unsupported binary files, and entry or sql on the wrong kind of file, say so plainly', async () => {
  writeFileSync(at('blob.bin'), new Uint8Array([0, 1, 2, 3, 255, 0, 7]))
  await expect(readFileAs(at('blob.bin'), 'blob.bin')).rejects.toThrow(
    'blob.bin is a binary file (7 bytes), not text, and not a format fs_read converts',
  )
  writeFileSync(at('notes.txt'), 'plain\n')
  await expect(readFileAs(at('notes.txt'), 'notes.txt', { entry: 'x' })).rejects.toThrow(
    'notes.txt is not one',
  )
  await expect(readFileAs(at('notes.txt'), 'notes.txt', { sql: 'SELECT 1' })).rejects.toThrow(
    'sql runs on a SQLite database, and notes.txt is not one',
  )
  expect(await readFileAs(at('notes.txt'), 'notes.txt')).toEqual({ text: 'plain\n' })
})

const host = {
  workspace: { resolveForRead: (_: string, p: string) => join(dir, p) },
} as unknown as ColonyHost
const fsRead = TOOL_DEFS.find((d) => d.name === 'fs_read')

test('fs_read pages through a converted document under a header outside the text', async () => {
  writeFileSync(at('plan.docx'), await encodeArchive('zip', DOCX))
  writeFileSync(at('lines.zip'), await encodeArchive('zip', [['a.txt', 'one\ntwo\nthree\n']]))
  expect(await fsRead?.run({ path: 'plan.docx' }, 'kai', host)).toEqual({
    text: 'Quarterly plan',
    images: [],
    preface: 'plan.docx: Word document, as Markdown.\n',
  })
  const page = await fsRead?.run({ path: 'lines.zip', entry: 'a.txt', offset: 2, limit: 1 }, 'kai', host)
  expect(page).toBe('(lines 2-2 of 3)\ntwo\n… lines 3-3 not shown: fs_read with offset: 3 reads on.')
})

test('fs_read returns an image as a picture, shrunk to what vision models take', async () => {
  writeFileSync(at('wide.png'), png(3000, 1000))
  const result = (await fsRead?.run({ path: 'wide.png' }, 'kai', host)) as {
    text: string
    images: { data: string; mimeType: string }[]
  }
  expect(result.text).toBe('wide.png: PNG image, 3000x1000, sent at 1568x523.')
  expect(result.images).toHaveLength(1)
  expect(result.images[0]?.mimeType).toStartWith('image/')
  expect(Buffer.from(result.images[0]?.data ?? '', 'base64').length).toBeLessThan(500 * 1024)
})

test('a text file that is not UTF-8 is still read as text, its odd bytes replaced; NUL bytes mean binary', async () => {
  // "café\n" in Latin-1: é is the single byte 0xE9, which is not valid UTF-8.
  writeFileSync(at('latin1.txt'), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  const read = await readFileAs(at('latin1.txt'), 'latin1.txt')
  expect(read.text).toBe('caf\uFFFD\n')
  expect(looksBinary(new Uint8Array([0x61, 0, 0x62]))).toBe(true)
  expect(looksBinary(new TextEncoder().encode('\x1b[32mgreen\x1b[0m\tok\r\n'))).toBe(false)
  expect(looksBinary(new Uint8Array([1, 2, 3, 4, 0x61]))).toBe(true)
})
