import './fonts.ts'
import { Composition } from 'remotion'
import { Film, FILM_FRAMES } from './Film.tsx'
import { HERO_FRAMES, HeroLoop } from './HeroLoop.tsx'
import { Social } from './Social.tsx'
import { FPS, H, W } from './theme.ts'

export function Root() {
  return (
    <>
      <Composition id="Film" component={Film} durationInFrames={FILM_FRAMES} fps={FPS} width={W} height={H} />
      <Composition id="HeroLoop" component={HeroLoop} durationInFrames={HERO_FRAMES} fps={FPS} width={W} height={H} />
      <Composition id="Social" component={Social} durationInFrames={1} fps={FPS} width={1280} height={640} />
    </>
  )
}
