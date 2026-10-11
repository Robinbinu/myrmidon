import { Composition, Still } from 'remotion'
import { Film, FILM_FRAMES } from './Film.tsx'
import { withFonts } from './fonts.ts'
import { HERO_FRAMES, HeroLoop } from './HeroLoop.tsx'
import { Social } from './Social.tsx'
import { STILLS } from './stills/index.ts'
import { FPS, H, W } from './theme.ts'

// The posters do not wait for the fonts on their own; the film's compositions do.
const POSTERS = STILLS.map((s) => ({ ...s, component: withFonts(s.component) }))

export function Root() {
  return (
    <>
      <Composition id="Film" component={Film} durationInFrames={FILM_FRAMES} fps={FPS} width={W} height={H} />
      <Composition id="HeroLoop" component={HeroLoop} durationInFrames={HERO_FRAMES} fps={FPS} width={W} height={H} />
      <Composition id="Social" component={Social} durationInFrames={1} fps={FPS} width={1280} height={640} />
      {POSTERS.map((s) => (
        <Still key={s.id} id={s.id} component={s.component} width={s.width} height={s.height} />
      ))}
    </>
  )
}
