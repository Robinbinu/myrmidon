import { AbsoluteFill } from 'remotion'
import { Icon, type IconName } from '../components/Icon.tsx'
import { LogoTile } from '../components/Led.tsx'
import { Cursor, MacWindow } from '../components/Ui.tsx'
import { C, CREW, FONT, MONO } from '../theme.ts'
import { Btn, Grain, Headline, Panel } from './kit.tsx'

/** A generic desktop's wallpaper: deep dusk with two soft pools of colour. */
function Wallpaper() {
  return (
    <AbsoluteFill
      style={{
        background: [
          'radial-gradient(900px 600px at 82% 108%, rgba(255,140,40,0.32) 0%, transparent 70%)',
          'radial-gradient(800px 520px at 8% 100%, rgba(140,70,200,0.22) 0%, transparent 70%)',
          'radial-gradient(1000px 700px at 60% -10%, rgba(60,80,160,0.18) 0%, transparent 70%)',
          'linear-gradient(180deg, #0b0b12 0%, #0d0a10 60%, #140c08 100%)',
        ].join(', '),
      }}
    />
  )
}

function MenuBar() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '0 22px',
        background: 'rgba(20,20,26,0.6)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontFamily: FONT,
        fontSize: 15,
        color: C.label2,
      }}
    >
      <span style={{ fontWeight: 700, color: C.label }}>Sheets</span>
      {['File', 'Edit', 'Insert', 'Format', 'Window'].map((m) => (
        <span key={m}>{m}</span>
      ))}
      <span style={{ flex: 1 }} />
      <Icon name="search" size={16} />
      <span>Tue 9:41</span>
    </div>
  )
}

/** The overlay's label: who is driving, and the one key that stops them. */
function EscPill() {
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: 52,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 44,
        padding: '0 10px 0 18px',
        borderRadius: 99,
        fontFamily: FONT,
        fontSize: 18,
        fontWeight: 560,
        whiteSpace: 'nowrap',
        color: '#ffd9a8',
        background: 'rgba(60,32,8,0.82)',
        boxShadow: '0 0 0 1px rgba(255,164,28,0.45), 0 12px 30px -8px rgba(0,0,0,0.8)',
      }}
    >
      <Icon name="pointer" size={19} color={C.accent} />
      2 agents are controlling your Mac
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 450, opacity: 0.85, marginLeft: 4 }}>
        Press
        <span
          style={{
            fontFamily: MONO,
            fontSize: 15,
            fontWeight: 600,
            padding: '4px 9px',
            borderRadius: 7,
            color: '#1a1204',
            background: C.wink,
          }}
        >
          esc
        </span>
        to stop
      </span>
    </div>
  )
}

const COLS = ['Client', 'Invoice', 'Amount', 'Due', 'Status']
const WIDTHS = [200, 120, 140, 130, 190]
const DATA: string[][] = [
  ['Northwind', '#1042', '$4,800', 'Oct 30', 'Ready'],
  ['Contoso', '#1043', '$2,150', 'Oct 30', 'Ready'],
  ['Fabrikam', '#1044', '$7,320', 'Nov 02', 'Ready'],
  ['Tailspin', '#1045', '$960', 'Nov 06', 'Draft'],
  ['Wingtip', '#1046', '$3,410', 'Nov 09', 'Draft'],
  ['Litware', '#1047', '$1,275', 'Nov 12', 'Draft'],
]
const ROW_H = 46
const SEL = CREW.nova.color

function Sheet() {
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: FONT }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 58,
          padding: '0 18px',
          borderBottom: `1px solid ${C.separator}`,
          background: '#131317',
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 15, color: C.label3, width: 60 }}>C2:C4</span>
        <span style={{ fontFamily: MONO, fontSize: 16, color: C.label2, flex: 1 }}>=SUM(C2:C4) → $14,270</span>
        <Btn size={15} icon="file">
          Export
        </Btn>
        <Btn size={15} kind="primary" icon="arrowUp" style={{ boxShadow: `0 0 0 2px ${CREW.iris.color}` }}>
          Send invoices
        </Btn>
      </div>
      <div style={{ position: 'relative', padding: '0 0 0 44px' }}>
        <div style={{ display: 'flex', height: 38, alignItems: 'center', borderBottom: `1px solid ${C.separator}`, background: '#101013' }}>
          {COLS.map((c, i) => (
            <span key={c} style={{ width: WIDTHS[i], paddingLeft: 14, fontSize: 15, fontWeight: 600, color: C.label3 }}>
              {c}
            </span>
          ))}
        </div>
        {DATA.map((row, r) => (
          <div key={row[0]} style={{ position: 'relative', display: 'flex', height: ROW_H, alignItems: 'center', borderBottom: `1px solid ${C.separator}` }}>
            <span style={{ position: 'absolute', left: -44, width: 44, textAlign: 'center', fontFamily: MONO, fontSize: 14, color: C.label4 }}>{r + 2}</span>
            {row.map((cell, i) => {
              const status = i === 4
              return (
                <span
                  key={COLS[i]}
                  style={{
                    width: WIDTHS[i],
                    paddingLeft: 14,
                    fontSize: 17,
                    fontFamily: i > 0 && i < 4 ? MONO : FONT,
                    color: status ? (cell === 'Ready' ? C.ok : C.label3) : i === 0 ? C.label : C.label2,
                    fontWeight: i === 0 ? 560 : 450,
                  }}
                >
                  {status && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        marginRight: 8,
                        verticalAlign: 2,
                        background: cell === 'Ready' ? C.ok : C.label4,
                      }}
                    />
                  )}
                  {cell}
                </span>
              )
            })}
          </div>
        ))}
        {/* nova's selection: the three invoices ready to go. */}
        <div
          style={{
            position: 'absolute',
            left: 44 + 200 + 120,
            top: 38,
            width: 140,
            height: ROW_H * 3,
            background: `${SEL}22`,
            boxShadow: `inset 0 0 0 2px ${SEL}`,
            borderRadius: 3,
          }}
        />
      </div>
    </div>
  )
}

/** The one step that leaves the Mac: sending mail to clients. The crew stops and asks. */
function Approval() {
  return (
    <Panel
      tone="raised"
      style={{
        left: 88,
        top: 520,
        width: 560,
        boxShadow:
          '0 0 0 1px rgba(255,179,26,0.5), 0 0 0 8px rgba(255,179,26,0.07), 0 0 80px -10px rgba(255,164,28,0.35), 0 60px 120px -20px rgba(0,0,0,1)',
      }}
    >
      <div style={{ padding: '22px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, display: 'grid', placeItems: 'center', background: C.accentSoft }}>
            <Icon name="shield" size={25} color={C.accent} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 24, fontWeight: 660, letterSpacing: '-0.01em' }}>Send 3 invoices?</div>
            <div style={{ fontSize: 17, color: C.label3, marginTop: 3 }}>
              <span style={{ color: CREW.iris.color, fontWeight: 600 }}>iris</span> wants to click Send invoices in Sheets
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {['Northwind · $4,800', 'Contoso · $2,150', 'Fabrikam · $7,320'].map((t) => (
            <span
              key={t}
              style={{ fontFamily: MONO, fontSize: 15, padding: '6px 10px', borderRadius: 8, color: C.label2, background: C.fillStrong, boxShadow: `inset 0 0 0 1px ${C.separator}` }}
            >
              {t}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
          <span style={{ fontSize: 15, color: C.label4, flex: 1 }}>Emails go out to 3 people.</span>
          <Btn size={17}>Deny</Btn>
          <Btn size={17} kind="primary">
            Allow once
          </Btn>
        </div>
      </div>
    </Panel>
  )
}

const DOCK: IconName[] = ['folder', 'globe', 'message', 'calendar', 'log', 'terminal', 'code']

function Dock() {
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: 24,
        background: 'rgba(30,30,36,0.55)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 20px 50px -10px rgba(0,0,0,0.8)',
      }}
    >
      {DOCK.map((d, i) => (
        <div
          key={d}
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            display: 'grid',
            placeItems: 'center',
            background: `linear-gradient(160deg, ${['#3a3a44', '#2b3b55', '#2c4a3a', '#4a2c34', '#3a3424', '#1d1d22', '#2c2c48'][i]} 0%, #16161b 100%)`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
          }}
        >
          <Icon name={d} size={26} color={C.label2} />
        </div>
      ))}
      <div style={{ width: 1, height: 40, background: 'rgba(255,255,255,0.14)', margin: '0 2px' }} />
      <LogoTile size={52} />
    </div>
  )
}

export function FeatureComputer() {
  return (
    <AbsoluteFill style={{ background: C.black, overflow: 'hidden' }}>
      <Wallpaper />
      <MenuBar />
      <MacWindow width={880} height={520} title="Invoices Q3" style={{ position: 'absolute', left: 660, top: 128 }}>
        <Sheet />
      </MacWindow>
      <Cursor color={CREW.nova.color} size={40} label="nova" style={{ left: 1136, top: 392 }} />
      <Cursor color={CREW.iris.color} size={40} label="iris" style={{ left: 1420, top: 128 + 52 + 40 }} />
      <Approval />
      <Dock />
      {/* Darken behind the headline so it reads on the wallpaper. */}
      <AbsoluteFill style={{ background: 'radial-gradient(700px 420px at 0% 22%, rgba(5,5,8,0.75) 0%, transparent 100%)' }} />
      <Headline
        eyebrow="Computer use"
        lead="It can use your Mac."
        accent="You stay in charge."
        breakAccent
        sub="Agents click and type in your apps with their own cursors. Anything that matters waits for your OK."
        width={540}
        size={56}
        style={{ left: 88, top: 128 }}
      />
      <EscPill />
      {/* The overlay's warm glow inside the screen's edge while agents drive. */}
      <AbsoluteFill
        style={{
          boxShadow: [
            'inset 0 0 0 4px rgba(255,150,40,0.9)',
            'inset 0 0 30px 8px rgba(255,150,40,0.55)',
            'inset 0 0 120px 30px rgba(255,150,40,0.2)',
          ].join(', '),
          borderRadius: 14,
        }}
      />
      <Grain />
    </AbsoluteFill>
  )
}

