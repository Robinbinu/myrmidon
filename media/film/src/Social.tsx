import { AbsoluteFill } from 'remotion'
import { LogoTile } from './components/Led.tsx'
import { Stage } from './components/Stage.tsx'
import { Cursor } from './components/Ui.tsx'
import { CrewPanel } from './scenes/Crew.tsx'
import { C, CREW, FONT, MONO } from './theme.ts'

/** The repository's social card, 1280×640: the mark, the line, and the crew at work in tilted panels. */
export function Social() {
  return (
    <Stage glow={{ x: 330, y: 300, strength: 1.2, size: 900 }} drift={0}>
      <div
        style={{
          position: 'absolute',
          left: 700,
          top: -10,
          width: 1800,
          height: 900,
          perspective: 1800,
          maskImage: 'linear-gradient(90deg, black 40%, transparent 70%)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 60,
            width: 1800,
            height: 900,
            transform: 'rotateY(-20deg) rotateX(8deg) rotateZ(-2deg) scale(0.5)',
            transformOrigin: '0 0',
          }}
        >
          {(['nova', 'quill', 'iris'] as const).map((who, i) => (
            <div key={who} style={{ position: 'absolute', left: i * 598, top: i * 26, width: 572, height: 872 }}>
              <CrewPanel who={who} p={who === 'iris' ? 260 : 450} done={who !== 'iris'} />
            </div>
          ))}
          <Cursor color={CREW.iris.color} size={40} label="iris" style={{ left: 1196 + 250, top: 52 + 470 }} tilt={-10} />
          <Cursor color={CREW.nova.color} size={40} label="nova" style={{ left: 360, top: 790 }} tilt={-10} />
        </div>
      </div>
      <AbsoluteFill
        style={{
          background: 'linear-gradient(90deg, rgba(5,5,6,0.96) 0%, rgba(5,5,6,0.85) 42%, transparent 62%)',
        }}
      />
      <div style={{ position: 'absolute', left: 76, top: 170, fontFamily: FONT, color: C.label }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <LogoTile size={104} glow={1.2} />
          <div style={{ fontSize: 100, fontWeight: 700, letterSpacing: '-0.05em', lineHeight: 1 }}>Myrmidon</div>
        </div>
        <div style={{ fontSize: 50, fontWeight: 650, letterSpacing: '-0.035em', marginTop: 40 }}>
          One chat. <span style={{ color: C.accent }}>A whole crew.</span>
        </div>
        <div style={{ fontSize: 23, color: C.label3, marginTop: 18 }}>AI agents that research, code and design together.</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 34 }}>
          {['Free and open source', 'Runs on your Mac'].map((t) => (
            <span
              key={t}
              style={{
                fontFamily: MONO,
                fontSize: 17,
                padding: '9px 16px',
                borderRadius: 99,
                color: C.label2,
                background: '#141418',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.12)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </Stage>
  )
}
