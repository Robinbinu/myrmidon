import type { Database } from 'bun:sqlite'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { notebookToEditableText, pdfToMarkdown } from '@oh-my-pi/pi-natives'
import { BINARY_SNIFF_BYTES } from '@oh-my-pi/pi-utils/binary'
import { parseImageMetadata } from '@oh-my-pi/pi-utils/mime'
import {
  READ_ARCHIVE_ENTRY_MAX_BYTES,
  READ_ARCHIVE_MAX_BYTES,
  READ_ARCHIVE_MAX_ENTRIES,
  READ_BINARY_CONTROL_SHARE,
  READ_DOCUMENT_MAX_BYTES,
  READ_SQL_MAX_ROWS,
} from './config.ts'
import { prompts } from './prompts.ts'

/**
 * How fs_read reads what is not plain text, with omp's readers as a library: PDFs through pi-natives' converter,
 * office documents and e-books through omp's markit engine, notebooks through pi-natives, archives through
 * pi-utils' archive reader, SQLite through omp's table helpers, and images shrunk the way omp's read tool shrinks
 * them. Path checks happen before this (the caller resolves the path for reading); everything here only reads.
 */

/** What fs_read gets for a file: text to page through with offset and limit, or a picture; `head` says what it was. */
export interface FileRead {
  readonly text: string
  readonly head?: string
  readonly image?: { readonly data: string; readonly mimeType: string }
}

/** A member inside an archive to read instead of its listing, or a query to run on a database. */
export interface ReadWant {
  readonly entry?: string
  readonly sql?: string
}

type DocumentKind = 'pdf' | 'image' | 'office' | 'notebook'

/**
 * Whether a file's first bytes are binary rather than text: a NUL byte, or more than a tenth control characters. Not
 * "not valid UTF-8", as omp's check has it: a Latin-1 or Windows-1252 text file is still text, read with its odd
 * bytes replaced, as fs_read always read it.
 */
export function looksBinary(head: Uint8Array): boolean {
  if (head.includes(0)) return true
  let control = 0
  for (const b of head)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) control++
  return head.length > 0 && control / head.length > READ_BINARY_CONTROL_SHARE
}

const SQLITE_MAGIC = 'SQLite format 3\0'

const looksLikeSqlite = (head: Uint8Array) =>
  head.length >= SQLITE_MAGIC.length &&
  new TextDecoder('latin1').decode(head.subarray(0, 16)) === SQLITE_MAGIC

/** Formats are told by their bytes where they have a signature, so a renamed file still reads as what it is. */
function documentKind(head: Uint8Array, ext: string): DocumentKind | undefined {
  if (new TextDecoder('latin1').decode(head.subarray(0, 5)) === '%PDF-') return 'pdf'
  if (parseImageMetadata(head)) return 'image'
  if (ext in prompts.toolResults.documentKinds) return 'office'
  if (ext === '.ipynb') return 'notebook'
  return undefined
}

function peek(path: string): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const buf = new Uint8Array(BINARY_SNIFF_BYTES)
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0))
  } finally {
    closeSync(fd)
  }
}

const archives = () => import('@oh-my-pi/pi-utils/ar')

/** Reads the file at `path` (already resolved and allowed); `name` is the path as the agent gave it. */
export async function readFileAs(path: string, name: string, want: ReadWant = {}): Promise<FileRead> {
  const head = peek(path)
  if (looksLikeSqlite(head)) {
    if (want.entry !== undefined) throw new Error(prompts.toolResults.readEntryNotArchive(name))
    return readSqlite(path, name, want.sql)
  }
  if (want.sql !== undefined) throw new Error(prompts.toolResults.readSqlNotDatabase(name))
  const ext = extname(path).toLowerCase()
  const format = (await archives()).archiveFormatFromPath(path)
  if (want.entry !== undefined) {
    if (!format) throw new Error(prompts.toolResults.readEntryNotArchive(name))
    return readArchive(path, name, want.entry)
  }
  const kind = documentKind(head, ext)
  if (kind) {
    const size = statSync(path).size
    if (size > READ_DOCUMENT_MAX_BYTES)
      throw new Error(prompts.toolResults.readTooBig(name, size, READ_DOCUMENT_MAX_BYTES))
    return convert(kind, name, ext, readFileSync(path))
  }
  if (looksBinary(head)) {
    if (format) return readArchive(path, name)
    throw new Error(prompts.toolResults.readBinary(name, statSync(path).size))
  }
  return { text: readFileSync(path, 'utf8') }
}

async function convert(kind: DocumentKind, name: string, ext: string, bytes: Uint8Array): Promise<FileRead> {
  const t = prompts.toolResults
  switch (kind) {
    case 'pdf': {
      const pdf = await pdfToMarkdown(bytes).catch((err: unknown) => {
        throw new Error(t.readConvertFailed(name, 'a PDF', reason(err)))
      })
      return { text: pdf.markdown, head: t.readPdf(name, pdf.pageCount, pdf.pagesNeedingOcr) }
    }
    case 'office': {
      const kindName = t.documentKinds[ext] ?? ext
      const result = await (await markit())
        .convert(Buffer.from(bytes), { extension: ext, filename: `document${ext}` })
        .catch((err: unknown) => {
          throw new Error(t.readConvertFailed(name, `a ${kindName} document`, reason(err)))
        })
      return { text: result.markdown, head: t.readDocument(name, kindName) }
    }
    case 'notebook': {
      let text: string
      try {
        text = notebookToEditableText(new TextDecoder().decode(bytes), name)
      } catch (err) {
        throw new Error(t.readConvertFailed(name, 'a Jupyter notebook', reason(err)))
      }
      return { text, head: t.readNotebook(name) }
    }
    case 'image': {
      const { resizeImage } = await import('@oh-my-pi/pi-coding-agent/utils/image-resize')
      // Downsized to what vision models take in (omp's defaults): a camera photo would otherwise blow the request.
      const image = await resizeImage(bytes)
      if (image.decodeFailed)
        throw new Error(t.readConvertFailed(name, 'an image', 'its pixels could not be decoded'))
      const type = (parseImageMetadata(bytes)?.mimeType ?? image.mimeType)
        .slice('image/'.length)
        .toUpperCase()
      const shrunk = image.width !== image.originalWidth || image.height !== image.originalHeight
      return {
        text: '',
        head: t.readImage(
          name,
          type,
          `${image.originalWidth}x${image.originalHeight}`,
          shrunk ? `${image.width}x${image.height}` : undefined,
        ),
        image: { data: image.data, mimeType: image.mimeType },
      }
    }
  }
}

type Markit = InstanceType<typeof import('@oh-my-pi/pi-coding-agent/markit').Markit>
let engine: Promise<Markit> | undefined
/**
 * omp's document engine, loaded on the first document read. Used directly rather than through omp's
 * convertFileWithMarkit, which keeps every converted document in a cache under ~/.omp: what an agent reads from the
 * person's files stays in this round.
 */
function markit(): Promise<Markit> {
  engine ??= import('@oh-my-pi/pi-coding-agent/markit').then(({ Markit }) => new Markit())
  return engine
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function readArchive(path: string, name: string, entry?: string): Promise<FileRead> {
  const t = prompts.toolResults
  const ar = await archives()
  const format = ar.archiveFormatFromPath(path)
  if (!format) throw new Error(t.readEntryNotArchive(name))
  // Stream formats (tar.gz…) decompress whole into memory: the caps keep a small bomb from filling it.
  const archive = await ar
    .openArchive(
      { path, format },
      { limits: { maxEntries: READ_ARCHIVE_MAX_ENTRIES, maxInMemorySize: READ_ARCHIVE_MAX_BYTES } },
    )
    .catch((err: unknown) => {
      throw new Error(t.readConvertFailed(name, `a ${format} archive`, reason(err)))
    })
  if (entry === undefined || entry.replace(/[\\/]+/g, '') === '') {
    const files = [...archive.indexEntries()]
      .filter((e) => !e.isDirectory)
      .sort((a, b) => a.path.localeCompare(b.path))
    const lines = ar.formatArchiveEntryLines(files.map((e) => ({ ...e, name: e.path })))
    return { text: lines.join('\n') || t.readEmptyArchive, head: t.readArchive(name, format, files.length) }
  }
  const node = archive.getNode(entry)
  if (!node) throw new Error(t.readNoEntry(entry, name))
  if (node.isDirectory) {
    const lines = ar.formatArchiveEntryLines(archive.listDirectory(entry))
    return { text: lines.join('\n') || t.readEmptyArchive, head: t.readArchiveFolder(name, node.path) }
  }
  const label = `${node.path} in ${name}`
  if (node.size > READ_ARCHIVE_ENTRY_MAX_BYTES)
    throw new Error(t.readTooBig(label, node.size, READ_ARCHIVE_ENTRY_MAX_BYTES))
  const { bytes } = await archive.readFile(entry)
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES)
  if (looksLikeSqlite(head) || ar.archiveFormatFromPath(node.path)) throw new Error(t.readNested(node.path))
  const ext = extname(node.path).toLowerCase()
  const kind = documentKind(head, ext)
  if (kind) return convert(kind, label, ext, bytes)
  if (looksBinary(head)) throw new Error(t.readBinary(label, bytes.length))
  return { text: new TextDecoder().decode(bytes) }
}

/**
 * Opens a database for reading without writing beside it: no journal or WAL sidecar files appear in the person's
 * folder. A WAL database whose sidecars are missing cannot open read-only, so it opens immutable instead (as the
 * file stands on disk).
 */
async function openReadOnly(path: string): Promise<Database> {
  const { Database } = await import('bun:sqlite')
  const ready = (db: Database) => {
    try {
      db.run('PRAGMA query_only = ON')
      db.run('PRAGMA busy_timeout = 3000')
      db.query('SELECT name FROM sqlite_master LIMIT 1').get()
      return db
    } catch (err) {
      db.close()
      throw err
    }
  }
  try {
    return ready(new Database(path, { readonly: true }))
  } catch {
    return ready(new Database(`${pathToFileURL(path).href}?immutable=1`, { readonly: true }))
  }
}

/** Leading comments, then the statement's first word: only queries that read may run. */
const READING_SQL = /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*(?:select|with|values)\b/i

async function readSqlite(path: string, name: string, sql?: string): Promise<FileRead> {
  const t = prompts.toolResults
  // ATTACH would open another file past the read-access checks, so only a reading statement is let through.
  if (sql !== undefined && !READING_SQL.test(sql)) throw new Error(t.readSqlSelectOnly)
  let db: Database
  try {
    db = await openReadOnly(path)
  } catch (err) {
    throw new Error(t.readConvertFailed(name, 'a SQLite database', reason(err)))
  }
  try {
    if (sql === undefined) {
      const { getTableSchema, listTables, renderTableList } = await import(
        '@oh-my-pi/pi-coding-agent/tools/sqlite-reader'
      )
      const tables = listTables(db)
      const text = tables
        .map((table) => `${renderTableList([table])}\n${getTableSchema(db, table.name)}`)
        .join('\n\n')
      return { text: text || t.readNoTables, head: t.readSqlite(name, tables.length) }
    }
    const rows: string[] = []
    let capped = false
    for (const row of db.query<Record<string, unknown>, []>(sql).iterate()) {
      if (rows.length >= READ_SQL_MAX_ROWS) {
        capped = true
        break
      }
      rows.push(JSON.stringify(row, sqlValue))
    }
    return { text: rows.join('\n'), head: t.readSqlRows(rows.length, capped) }
  } finally {
    db.close()
  }
}

/** Blobs are named by size rather than dumped; 64-bit integers keep every digit. */
function sqlValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `(${value.length} bytes of binary)`
  return value
}
