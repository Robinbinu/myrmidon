import { useLayoutEffect } from 'react'
import { useCurrentFrame } from 'remotion'
import { H, W } from '../theme.ts'

/**
 * Debug-only (render with `--props='{"debug":true}'`): after each frame commits, measures every piece of text on
 * screen and logs one `OVERLAP <json>` line that scripts/check-overlaps.mjs collects. Text is anything tagged `data-t`
 * (the T component and caption words); containers are `data-box`; `data-caption` is the caption band; `data-cover`
 * names something laid over the scene (mail, a cursor's tag, a card or bubble in flight, the stamp), which must not
 * cover text unless it is on its way across (the script tells moving from resting by comparing frames);
 * `data-mb` is a motion-blur copy (the debug render draws none) and `data-scroll` a scrolling log whose lines are
 * meant to slide past its edge.
 */

type Rect = { x: number; y: number; w: number; h: number }
const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height })
const inter = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.w, b.x + b.w) - x
  const h = Math.min(a.y + a.h, b.y + b.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/** The element's opacity as seen, its blur, and its box clipped by every overflow-hidden ancestor and the frame. */
function seen(el: Element): { opacity: number; blur: number; clip: Rect | null } {
  let opacity = 1
  let blur = 0
  let clip: Rect | null = rectOf(el.getBoundingClientRect())
  clip = clip && inter(clip, { x: 0, y: 0, w: W, h: H })
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n)
    opacity *= Number.parseFloat(cs.opacity)
    const m = /blur\(([\d.]+)px\)/.exec(cs.filter)
    if (m?.[1]) blur += Number.parseFloat(m[1])
    if (n !== el && clip && cs.overflow !== 'visible') clip = inter(clip, rectOf(n.getBoundingClientRect()))
  }
  return { opacity, blur, clip }
}

const label = (el: Element) => (el.textContent ?? '').trim().slice(0, 40)

/**
 * An element's box in layout space, before any transform: the offset chain summed up. Two lines of text in the same
 * container are compared here, so a tilted card's lines are not flagged for their tilted bounding boxes touching.
 */
function layoutRect(el: Element): Rect | null {
  if (!(el instanceof HTMLElement)) return null
  let x = 0
  let y = 0
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft
    y += n.offsetTop
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight }
}

export function measureFrame(frame: number) {
  const problems: { kind: string; a: string; b?: string; cover?: string; at?: Rect }[] = []
  const texts = [...document.querySelectorAll('[data-t]')]
    .filter((el) => !el.closest('[data-mb]'))
    .map((el) => ({ el, ...seen(el), cover: el.closest('[data-cover]'), caption: el.hasAttribute('data-caption-word') }))
    .filter((t) => t.clip && t.opacity > 0.2 && t.blur < 3)
  // Things laid over the scene (mail, cursor tags, flying cards, the bubble, the stamp): none may cover text.
  const covers = [...document.querySelectorAll('[data-cover]')]
    .map((el) => ({ el, id: el.getAttribute('data-cover') ?? '', ...seen(el) }))
    .filter((c) => c.clip && c.opacity > 0.2 && c.blur < 3)
  for (const c of covers)
    for (const t of texts) {
      if (c.el.contains(t.el) || t.cover === c.el) continue
      // Text drawn after the cover sits above it (the film sets no z-order against document order): not covered.
      if (c.el.compareDocumentPosition(t.el) & Node.DOCUMENT_POSITION_FOLLOWING) continue
      const o = c.clip && t.clip && inter(c.clip, t.clip)
      if (o && o.w > 1.5 && o.h > 1.5) problems.push({ kind: 'covers text', a: c.id, b: label(t.el), cover: c.id, at: o })
    }
  for (const t of texts) {
    const own = rectOf(t.el.getBoundingClientRect())
    if (t.el instanceof HTMLElement && t.el.scrollWidth > t.el.clientWidth + 1)
      problems.push({ kind: 'overflows its own box', a: label(t.el) })
    const box = t.el.closest('[data-box]')
    if (box && !t.el.closest('[data-scroll]')) {
      const b = rectOf(box.getBoundingClientRect())
      if (own.x < b.x - 1.5 || own.y < b.y - 1.5 || own.x + own.w > b.x + b.w + 1.5 || own.y + own.h > b.y + b.h + 1.5)
        problems.push({ kind: 'exits its container', a: label(t.el), at: own })
    }
  }
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const b = texts[j]
      if (!a?.clip || !b?.clip || a.el.contains(b.el) || b.el.contains(a.el)) continue
      // Text on a cover against text elsewhere is the cover's overlap, checked above.
      if (a.cover !== b.cover) continue
      const box = a.el.closest('[data-box]')
      const sameBox = box !== null && box === b.el.closest('[data-box]')
      const la = sameBox ? layoutRect(a.el) : null
      const lb = sameBox ? layoutRect(b.el) : null
      // Both as seen (clipped, so text scrolled out of view does not count) and, within one box, as laid out.
      const seenO = inter(a.clip, b.clip)
      const o = seenO && la && lb ? inter(la, lb) : seenO
      if (o && o.w > 1.5 && o.h > 1.5)
        problems.push({ kind: 'text overlaps text', a: label(a.el), b: label(b.el), at: o })
    }
  const boxes = [...document.querySelectorAll('[data-box]')]
    .filter((el) => !el.closest('[data-mb]'))
    .map((el) => ({ el, ...seen(el) }))
    .filter((b) => b.clip && b.opacity > 0.3 && b.blur < 3)
  for (const t of texts.filter((x) => x.caption))
    for (const b of boxes) {
      const o = t.clip && b.clip && inter(t.clip, b.clip)
      if (o && o.w > 1.5 && o.h > 1.5) problems.push({ kind: 'caption overlaps UI', a: label(t.el), b: label(b.el) || 'a panel', at: o })
    }
  return { frame, texts: texts.length, covers: covers.map((c) => ({ id: c.id, at: c.clip })), problems }
}

export function OverlapProbe() {
  const frame = useCurrentFrame()
  useLayoutEffect(() => {
    console.log(`OVERLAP ${JSON.stringify(measureFrame(frame))}`)
  }, [frame])
  return null
}
