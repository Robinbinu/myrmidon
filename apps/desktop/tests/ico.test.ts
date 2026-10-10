import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packIco, pngSize } from '../src/ico.ts'

/** A PNG's signature and IHDR chunk for a `size` square, which is all packIco reads. */
function png(size: number, extra = 0): Uint8Array {
  const out = new Uint8Array(33 + extra)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(out.buffer)
  view.setUint32(8, 13)
  out.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  )
  view.setUint32(16, size)
  view.setUint32(20, size)
  return out
}

test('an .ico holds each PNG as it is, smallest first, behind a header and one entry per image', () => {
  const big = png(256, 7)
  const small = png(16)
  const ico = packIco([big, small])
  const view = new DataView(ico.buffer)
  expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 2])
  const entry = (i: number) => ({
    width: view.getUint8(6 + 16 * i),
    height: view.getUint8(7 + 16 * i),
    planes: view.getUint16(10 + 16 * i, true),
    bits: view.getUint16(12 + 16 * i, true),
    bytes: view.getUint32(14 + 16 * i, true),
    offset: view.getUint32(18 + 16 * i, true),
  })
  expect(entry(0)).toEqual({ width: 16, height: 16, planes: 1, bits: 32, bytes: small.length, offset: 38 })
  // 256 is written as 0.
  expect(entry(1)).toEqual({
    width: 0,
    height: 0,
    planes: 1,
    bits: 32,
    bytes: big.length,
    offset: 38 + small.length,
  })
  expect(ico.subarray(38, 38 + small.length)).toEqual(small)
  expect(ico.subarray(38 + small.length)).toEqual(big)
})

test('only square PNGs up to 256 px go in', () => {
  expect(() => packIco([png(512)])).toThrow('at most 256')
  expect(() => packIco([new Uint8Array(40)])).toThrow('not a PNG')
  const wide = png(32)
  new DataView(wide.buffer).setUint32(20, 16)
  expect(() => packIco([wide])).toThrow('square')
})

test('the committed app icon is a valid .ico of the iconset’s images', () => {
  const ico = new Uint8Array(readFileSync(join(import.meta.dir, '..', 'assets', 'icon.ico')))
  const view = new DataView(ico.buffer)
  const count = view.getUint16(4, true)
  const sizes = Array.from({ length: count }, (_, i) => {
    const offset = view.getUint32(18 + 16 * i, true)
    const bytes = view.getUint32(14 + 16 * i, true)
    return pngSize(ico.subarray(offset, offset + bytes)).width
  })
  expect(sizes).toEqual([16, 32, 48, 64, 128, 256])
  const png16 = new Uint8Array(
    readFileSync(join(import.meta.dir, '..', 'assets', 'icon.iconset', 'icon_16x16.png')),
  )
  expect(pngSize(png16)).toEqual({ width: 16, height: 16 })
})
