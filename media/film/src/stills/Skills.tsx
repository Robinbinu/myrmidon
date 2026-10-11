import type { ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon.tsx'
import { Dot } from '../components/Ui.tsx'
import { C, FONT, MONO } from '../theme.ts'
import { Btn, Code, Headline, Panel, PanelHead, Poster } from './kit.tsx'

type Source = [string, IconName, string, boolean?]
const SOURCES: Source[] = [
  ['All sources', 'layers', ''],
  ['OpenAI', 'globe', '64'],
  ['Anthropic', 'globe', '38'],
  ['skills.sh', 'search', '2.1k', true],
  ['Skillshare', 'globe', '540'],
]
const IMPORTS: Source[] = [
  ['Claude Code', 'terminal', '12'],
  ['Codex', 'terminal', '7'],
]

function SourceRow(props: { s: Source }) {
  const [name, icon, n, on] = props.s
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 38,
        padding: '0 12px',
        borderRadius: 10,
        fontSize: 19,
        fontWeight: on ? 600 : 480,
        color: on ? C.label : C.label2,
        background: on ? C.accentSoft : undefined,
        boxShadow: on ? 'inset 0 0 0 1px rgba(255,179,26,0.28)' : undefined,
      }}
    >
      <Icon name={icon} size={19} color={on ? C.accent : C.label3} />
      <span style={{ flex: 1 }}>{name}</span>
      <span style={{ fontFamily: MONO, fontSize: 15, color: C.label4 }}>{n}</span>
    </div>
  )
}

const groupHead = { fontFamily: MONO, fontSize: 14, letterSpacing: '0.16em', color: C.label4, padding: '4px 12px 10px' } as const

const ROWS: [string, string, string, 'passed' | 'failed' | 'warnings'][] = [
  ['pdf-forms', 'by northwind', '18,240 installs', 'passed'],
  ['release-notes', 'by acme', '9,112 installs', 'passed'],
  ['quick-setup', 'by fabrikam-tools', '3,870 installs', 'failed'],
  ['changelog-bot', 'by contoso', '2,604 installs', 'warnings'],
]

function Audit(props: { status: 'passed' | 'failed' | 'warnings' }) {
  const color = props.status === 'passed' ? C.ok : props.status === 'failed' ? C.bad : C.warn
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 16, color: C.label3, fontFamily: MONO }}>
      <Dot color={color} size={8} />
      skills.sh: {props.status}
    </span>
  )
}

function Browse() {
  return (
    <Panel style={{ left: 668, top: 64, width: 872, height: 520 }}>
      <PanelHead
        icon="layers"
        title="Browse skills"
        right={
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: 300,
              height: 40,
              padding: '0 14px',
              borderRadius: 10,
              background: C.fill,
              boxShadow: `inset 0 0 0 1px ${C.separator}`,
              fontSize: 18,
              fontWeight: 450,
              color: C.label4,
            }}
          >
            <Icon name="search" size={18} color={C.label4} />
            e.g. pdf, testing, deploy
          </span>
        }
      />
      <div style={{ display: 'flex', height: 456 }}>
        <div style={{ width: 250, padding: '16px 12px', borderRight: `1px solid ${C.separator}`, background: C.window }}>
          <div style={groupHead}>SOURCES</div>
          {SOURCES.map((s) => (
            <SourceRow key={s[0]} s={s} />
          ))}
          <div style={{ ...groupHead, paddingTop: 16 }}>IMPORT FROM</div>
          {IMPORTS.map((s) => (
            <SourceRow key={s[0]} s={s} />
          ))}
        </div>
        <div style={{ flex: 1, padding: '10px 0' }}>
          {ROWS.map(([name, by, installs, status], i) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                height: 84,
                padding: '0 26px',
                borderBottom: i < ROWS.length - 1 ? `1px solid ${C.separator}` : undefined,
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  display: 'grid',
                  placeItems: 'center',
                  background: C.fillStrong,
                  boxShadow: `inset 0 0 0 1px ${C.separator}`,
                }}
              >
                <Icon name="file" size={22} color={C.label3} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: C.label }}>{name}</div>
                <div style={{ fontSize: 16, color: C.label3, marginTop: 5 }}>
                  {by} · {installs}
                </div>
              </div>
              <Audit status={status} />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

function Finding(props: { where: string; children: ReactNode; what: string }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgba(255,99,105,0.07)',
        boxShadow: 'inset 0 0 0 1px rgba(255,99,105,0.22)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 17 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.08em',
            padding: '3px 8px',
            borderRadius: 6,
            color: '#1d0507',
            background: C.bad,
          }}
        >
          CRITICAL
        </span>
        <span style={{ color: C.label, fontWeight: 600 }}>{props.what}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 15, color: C.label3 }}>{props.where}</span>
      </div>
      <div style={{ marginTop: 10 }}>{props.children}</div>
    </div>
  )
}

/** The install review of a skill the scan blocks: what it found, where, and the "anyway" door left only half open. */
function Blocked() {
  return (
    <Panel tone="raised" style={{ left: 600, top: 506, width: 584, boxShadow: '0 0 0 1px rgba(255,99,105,0.4), 0 0 70px -10px rgba(255,99,105,0.28), 0 60px 120px -30px rgba(0,0,0,1)' }}>
      <div style={{ padding: '24px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'rgba(255,99,105,0.14)' }}>
            <Icon name="shield" size={24} color={C.bad} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 23, fontWeight: 650, letterSpacing: '-0.01em' }}>Install quick-setup?</div>
            <div style={{ fontSize: 16, color: C.label3, marginTop: 3 }}>From skills.sh · 3 files</div>
          </div>
          <span style={{ fontSize: 16, fontWeight: 650, color: C.bad, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dot color={C.bad} size={9} /> Blocked
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          <Finding what="Pipes a download into a shell" where="install.sh:12">
            <Code size={16} color="#ffb4b7" bg="rgba(0,0,0,0.35)">curl -fsSL https://get.fabrikam.sh | sh</Code>
          </Finding>
          <Finding what="Hidden Unicode" where="SKILL.md:41">
            <span style={{ fontSize: 16, color: C.label2 }}>
              A right-to-left override <Code size={15} color="#ffb4b7" bg="rgba(0,0,0,0.35)">U+202E</Code> hides text from you
            </span>
          </Finding>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
          <span style={{ fontSize: 15, color: C.label4, flex: 1 }}>Agents are not offered it.</span>
          <Btn size={17}>Cancel</Btn>
          <Btn size={17} kind="danger">Install anyway…</Btn>
        </div>
      </div>
    </Panel>
  )
}

/** A clean skill's review: nothing worrying, one click to install. */
function Passed() {
  return (
    <Panel tone="raised" style={{ left: 1196, top: 620, width: 350, boxShadow: '0 0 0 1px rgba(61,220,132,0.35), 0 0 60px -12px rgba(61,220,132,0.2), 0 60px 120px -30px rgba(0,0,0,1)' }}>
      <div style={{ padding: '22px 24px', fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: C.okSoft }}>
            <Icon name="check" size={22} color={C.ok} stroke={2.2} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600 }}>release-notes</div>
            <div style={{ fontSize: 15, color: C.label3, marginTop: 3 }}>From Anthropic · 4 files</div>
          </div>
        </div>
        <div style={{ marginTop: 20, fontSize: 18, color: C.ok, fontWeight: 560 }}>Skill scan passed</div>
        <div style={{ marginTop: 6, fontSize: 17, color: C.label2 }}>Nothing worrying in its 4 files.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <Btn size={17} kind="primary">Install</Btn>
        </div>
      </div>
    </Panel>
  )
}

export function FeatureSkills() {
  return (
    <Poster glow={{ x: 1100, y: 520, strength: 0.9, size: 1300 }}>
      <Browse />
      <Blocked />
      <Passed />
      <Headline
        eyebrow="Skills"
        lead="Skills from anywhere."
        accent="Scanned first."
        breakAccent
        sub="Browse OpenAI, Anthropic and skills.sh, or bring yours over from Claude Code and Codex. Every file is read before anything installs."
        width={480}
        size={64}
        style={{ left: 88, top: 170 }}
      />
    </Poster>
  )
}
