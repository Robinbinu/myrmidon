import type { ComponentType, ReactNode } from 'react'
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion'
import { tween } from './anim.ts'
import { SCENES } from './Film.tsx'
import { C } from './theme.ts'

/** The README's looping cut: the crew at work, the review stamp, the end card. [scene, first frame, last frame]. */
const CUTS: [string, number, number][] = [
  ['Crew', 330, 690],
  ['Coord', 290, 470],
  ['End', 0, 300],
]
const XFADE = 16

function Fade(props: { dur: number; children: ReactNode }) {
  const frame = useCurrentFrame()
  const opacity = Math.min(tween(frame, 0, XFADE), 1 - tween(frame, props.dur - XFADE, props.dur))
  return <AbsoluteFill style={{ opacity }}>{props.children}</AbsoluteFill>
}

const placed = (() => {
  let at = 0
  return CUTS.map(([name, a, b]) => {
    const scene = SCENES.find((s) => s.name === name)
    if (!scene) throw new Error(`No scene named ${name}`)
    const entry = { name, at, a, len: b - a, dur: scene.dur, Scene: scene.Scene as ComponentType<{ dur: number }> }
    at += b - a - XFADE
    return entry
  })
})()

export const HERO_FRAMES = (placed.at(-1)?.at ?? 0) + (placed.at(-1)?.len ?? 0)

export function HeroLoop() {
  return (
    <AbsoluteFill style={{ background: C.black }}>
      {placed.map(({ name, at, a, len, dur, Scene }) => (
        <Sequence key={name} from={at} durationInFrames={len}>
          <Fade dur={len}>
            <Sequence from={-a}>
              <Scene dur={dur} />
            </Sequence>
          </Fade>
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
