import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { MyrError } from './errors.ts'

const HASH = /^[0-9a-f]{64}$/

/** Content-addressed, immutable blob store. A blob's name is the SHA-256 of its bytes. */
export class BlobStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  static hash(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  }

  private _path(hash: string) {
    if (!HASH.test(hash)) throw new MyrError('BLOB_NOT_FOUND', `invalid blob hash: ${hash}`)
    return join(this.root, hash.slice(0, 2), hash.slice(2))
  }

  async put(content: Uint8Array | string): Promise<{ hash: string; size: number }> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const hash = BlobStore.hash(bytes)
    const path = this._path(hash)
    if (!(await Bun.file(path).exists())) {
      mkdirSync(join(this.root, hash.slice(0, 2)), { recursive: true })
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
      await Bun.write(tmp, bytes)
      renameSync(tmp, path)
    }
    return { hash, size: bytes.byteLength }
  }

  async get(hash: string): Promise<Uint8Array> {
    const file = Bun.file(this._path(hash))
    if (!(await file.exists())) throw new MyrError('BLOB_NOT_FOUND', `no blob ${hash}`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (BlobStore.hash(bytes) !== hash)
      throw new MyrError('BLOB_CORRUPT', `blob ${hash} failed its hash check`)
    return bytes
  }

  async text(hash: string): Promise<string> {
    return new TextDecoder().decode(await this.get(hash))
  }
}
