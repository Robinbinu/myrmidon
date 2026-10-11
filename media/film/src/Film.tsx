import { AbsoluteFill, getInputProps, useCurrentFrame } from 'remotion'
import { OverlapProbe } from './components/Debug.tsx'
import { Caption } from './components/Text.tsx'
import { Backdrop, Camera, Lens } from './components/World.tsx'
import { useFontsReady } from './fonts.ts'
import { AppLayer } from './shots/App.tsx'
import { BubbleFlight, PhoneAsk } from './shots/Ask.tsx'
import { AuditLog, Board, FoldFlight, StampAndApproval } from './shots/Board.tsx'
import { Call } from './shots/Call.tsx'
import { LoneCaret, QuestionDots } from './shots/Composer.tsx'
import { MailLane, PanelCursors, Panels, SpawnFlight } from './shots/Crew.tsx'
import { End } from './shots/End.tsx'
import { BurstDots, Reach } from './shots/Reach.tsx'
import { Scatter } from './shots/Scatter.tsx'
import { Soundtrack } from './Soundtrack.tsx'
import { BEAT, CAPTIONS, cameraAt, glowAt, worldFade } from './timeline.ts'
import { C } from './theme.ts'

export { FILM_FRAMES } from './timeline.ts'

/**
 * The film: one world under one camera (beats 1–6), the call, the reach and the end card in screen space (beats 7–9),
 * the captions above everything in their own band, and the lens over all of it. Every shot reads the global frame, so
 * the objects that cross from one shot into the next are the same objects.
 */
export function Film() {
  const ready = useFontsReady()
  const f = useCurrentFrame()
  if (!ready) return <AbsoluteFill style={{ background: C.black }} />
  const cam = cameraAt(f)
  const fade = worldFade(f)
  const debug = Boolean(getInputProps().debug)
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <Backdrop cam={cam} glow={glowAt(f)} />
      {fade.opacity > 0.001 && (
        <Camera cam={cam} opacity={fade.opacity} blur={fade.blur}>
          <Scatter />
          <AppLayer f={f} rowsGone={f >= BEAT.spawn} />
          <LoneCaret f={f} />
          <QuestionDots f={f} />
          <PhoneAsk f={f} />
          <BubbleFlight f={f} />
          <Panels f={f} />
          <SpawnFlight f={f} />
          <PanelCursors f={f} />
          <Board f={f} />
          <FoldFlight f={f} />
          <AuditLog f={f} />
          <StampAndApproval f={f} />
        </Camera>
      )}
      <Call f={f} />
      <Reach f={f} />
      <End f={f} />
      <BurstDots f={f} />
      <MailLane f={f} />
      {CAPTIONS.map((c) => (
        <Caption key={c.text} {...c} />
      ))}
      <Lens />
      <Soundtrack />
      {debug && <OverlapProbe />}
    </AbsoluteFill>
  )
}
