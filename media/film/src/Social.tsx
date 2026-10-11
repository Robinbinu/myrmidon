import { Code2, Star } from 'lucide-react'
import { AbsoluteFill } from 'remotion'
import { Chip } from './components/Surface.tsx'
import { T } from './components/Text.tsx'
import { Wordmark, WORDMARK_COLS, WORDMARK_ROWS } from './components/Wordmark.tsx'
import { Backdrop, Lens } from './components/World.tsx'
import { SPACE } from './design.ts'
import { useFontsReady } from './fonts.ts'
import { REPO } from './shots/End.tsx'
import { C } from './theme.ts'

const PITCH = 14

/** The repository's social card, 1280×640: the dot-matrix wordmark, the line, and where to get it. */
export function Social() {
  const ready = useFontsReady()
  if (!ready) return <AbsoluteFill style={{ background: C.black }} />
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Backdrop cam={{ x: 0, y: 0, s: 1, rz: 0, rx: 0, ry: 0 }} glow={{ x: 640, y: 230, strength: 1.4, size: 1100 }} />
      <div style={{ position: 'absolute', left: 640 - (WORDMARK_COLS * PITCH) / 2, top: 200 - (WORDMARK_ROWS * PITCH) / 2 }}>
        <Wordmark pitch={PITCH} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 318, display: 'flex', justifyContent: 'center', gap: SPACE[4] }}>
        <T role="caption">One chat.</T>
        <T role="caption" color={C.accent}>
          A whole crew.
        </T>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 412, display: 'flex', justifyContent: 'center' }}>
        <T role="heading" weight="regular" color={C.label3}>
          Free and open source · Runs on your Mac
        </T>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 480, display: 'flex', justifyContent: 'center', gap: SPACE[4] }}>
        <Chip big mono icon={Code2}>
          {REPO}
        </Chip>
        <Chip big tone="accent" icon={Star}>
          Star
        </Chip>
      </div>
      <Lens />
    </AbsoluteFill>
  )
}
