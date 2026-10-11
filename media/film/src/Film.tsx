import type { ComponentType } from 'react'
import { AbsoluteFill, Sequence } from 'remotion'
import { C } from './theme.ts'
import { Ask } from './scenes/Ask.tsx'
import { Call } from './scenes/Call.tsx'
import { Coord } from './scenes/Coord.tsx'
import { Crew } from './scenes/Crew.tsx'
import { End } from './scenes/End.tsx'
import { Opening } from './scenes/Opening.tsx'
import { Reach } from './scenes/Reach.tsx'
import { Trust } from './scenes/Trust.tsx'

/** The cut: each scene's first frame and length. Neighbours overlap by a short cross-dissolve. */
export const SCENES: { name: string; from: number; dur: number; Scene: ComponentType<{ dur: number }> }[] = [
  { name: 'Opening', from: 0, dur: 640, Scene: Opening },
  { name: 'Ask', from: 625, dur: 430, Scene: Ask },
  { name: 'Crew', from: 1040, dur: 800, Scene: Crew },
  { name: 'Coord', from: 1825, dur: 490, Scene: Coord },
  { name: 'Trust', from: 2300, dur: 430, Scene: Trust },
  { name: 'Call', from: 2715, dur: 490, Scene: Call },
  { name: 'Reach', from: 3190, dur: 380, Scene: Reach },
  { name: 'End', from: 3555, dur: 375, Scene: End },
]

export const FILM_FRAMES = Math.max(...SCENES.map((s) => s.from + s.dur))

export function Film() {
  return (
    <AbsoluteFill style={{ background: C.black }}>
      {SCENES.map(({ name, from, dur, Scene }) => (
        <Sequence key={name} name={name} from={from} durationInFrames={dur}>
          <Scene dur={dur} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
