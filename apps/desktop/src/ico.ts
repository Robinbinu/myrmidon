/**
 * Packs PNG images into a Windows `.ico`, for the app's Windows icon (scripts/icons.ts). Each image is stored as
 * the PNG it is, which Windows reads since Vista: a 6-byte header, a 16-byte entry per image (its size, where its
 * data starts), then the PNGs one after another. Little-endian throughout; a size of 256 is written as 0.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const HEADER = 6
const ENTRY = 16

/** A PNG's width and height, from its IHDR chunk (always first, right after the signature). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) throw new Error('not a PNG image')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR')
    throw new Error('PNG without an IHDR chunk first')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** An `.ico` holding `pngs`, square images up to 256 px, smallest first. */
export function packIco(pngs: readonly Uint8Array[]): Uint8Array {
  const images = pngs.map((png) => ({ png, ...pngSize(png) })).sort((a, b) => a.width - b.width)
  for (const { width, height } of images)
    if (width !== height || width < 1 || width > 256)
      throw new Error(`an icon image must be square and at most 256 px, not ${width}x${height}`)
  const size = HEADER + ENTRY * images.length + images.reduce((sum, i) => sum + i.png.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true) // 1: icon (2 would be a cursor)
  view.setUint16(4, images.length, true)
  let offset = HEADER + ENTRY * images.length
  images.forEach(({ png, width }, i) => {
    const entry = HEADER + ENTRY * i
    view.setUint8(entry, width === 256 ? 0 : width)
    view.setUint8(entry + 1, width === 256 ? 0 : width)
    view.setUint8(entry + 2, 0) // no palette
    view.setUint8(entry + 3, 0)
    view.setUint16(entry + 4, 1, true) // colour planes
    view.setUint16(entry + 6, 32, true) // bits per pixel
    view.setUint32(entry + 8, png.length, true)
    view.setUint32(entry + 12, offset, true)
    out.set(png, offset)
    offset += png.length
  })
  return out
}
