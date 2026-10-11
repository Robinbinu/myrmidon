import { Icon } from '../components/Icon.tsx'
import { LedScreen } from '../components/Led.tsx'
import { C, MONO } from '../theme.ts'
import { Btn, Headline, Panel, PanelHead, Poster } from './kit.tsx'

/** What Alex said, in the chat the suggestions come from. */
function Said() {
  return (
    <Panel tone="window" style={{ left: 88, top: 70, width: 812, height: 150 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 22px 0', fontSize: 15, color: C.label4, fontFamily: MONO, letterSpacing: '0.08em' }}>
        <Icon name="message" size={16} color={C.label4} />
        PRICING PAGE · TODAY 09:12
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 22px' }}>
        <div
          style={{
            maxWidth: 620,
            padding: '13px 18px',
            borderRadius: 20,
            borderBottomRightRadius: 6,
            fontSize: 20,
            lineHeight: 1.35,
            color: '#141416',
            background: C.user,
          }}
        >
          We write everything in TypeScript. And deploys go through staging first, always.
        </div>
      </div>
    </Panel>
  )
}

const KINDS = { preference: '#ff7eb6', decision: C.accent, fact: '#4d7cff' } as const

function Suggestion(props: { kind: keyof typeof KINDS; text: string; kept?: boolean; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        height: 92,
        padding: '0 24px',
        borderBottom: props.last ? undefined : `1px solid ${C.separator}`,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: props.kept ? C.label2 : C.label }}>{props.text}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 15, color: C.label4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: KINDS[props.kind] }} />
          <span style={{ fontFamily: MONO, color: C.label3 }}>{props.kind}</span>· from Pricing page · every chat
        </div>
      </div>
      {props.kept ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 600, color: C.ok }}>
          <Icon name="check" size={20} color={C.ok} stroke={2.2} /> Kept
        </span>
      ) : (
        <>
          <Btn size={17}>Discard</Btn>
          <Btn size={17} kind="primary">
            Keep
          </Btn>
        </>
      )}
    </div>
  )
}

function Suggestions() {
  return (
    <Panel style={{ left: 88, top: 252, width: 812, height: 342 }}>
      <PanelHead
        icon="sparkle"
        title="Suggested memories"
        right={<span style={{ fontSize: 16, fontWeight: 450, color: C.label4 }}>2 waiting for you</span>}
      />
      <Suggestion kind="preference" text="Alex prefers TypeScript" />
      <Suggestion kind="decision" text="Deploys go through staging first" kept />
      <Suggestion kind="fact" text="Release notes go out on Fridays" last />
    </Panel>
  )
}

/** A skill Myrmidon proposes from steps it saw repeat: offered, never added on its own. */
function LearnedSkill() {
  return (
    <Panel
      tone="raised"
      style={{
        left: 88,
        top: 626,
        width: 812,
        boxShadow:
          '0 0 0 1px rgba(255,179,26,0.45), 0 0 0 8px rgba(255,179,26,0.05), 0 0 80px -16px rgba(255,164,28,0.35), 0 50px 110px -30px rgba(0,0,0,0.95)',
      }}
    >
      <div style={{ display: 'flex', gap: 18, padding: '22px 24px' }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, display: 'grid', placeItems: 'center', background: C.accentSoft, flexShrink: 0 }}>
          <Icon name="workflow" size={26} color={C.accent} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.14em', color: C.wink }}>SKILL SUGGESTED</div>
          <div style={{ fontSize: 23, fontWeight: 650, marginTop: 6 }}>
            <span style={{ fontFamily: MONO, fontWeight: 600 }}>ship-via-staging</span>
          </div>
          <div style={{ fontSize: 17, color: C.label3, marginTop: 6, lineHeight: 1.4 }}>
            The same steps in 3 chats: build, test, deploy to staging, wait for Alex’s OK, promote.
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '0 24px 20px' }}>
        <Btn size={17}>Not now</Btn>
        <Btn size={17} kind="primary">
          Review skill
        </Btn>
      </div>
    </Panel>
  )
}

export function FeatureMemory() {
  return (
    <Poster glow={{ x: 1180, y: 600, strength: 1, size: 1100 }}>
      <Said />
      <Suggestions />
      <LearnedSkill />
      <Headline
        eyebrow="Memory"
        lead="Memory"
        accent="you approve."
        breakAccent
        sub="After a chat, Myrmidon suggests what to remember and which steps to turn into a skill. Nothing is kept until you keep it."
        width={530}
        size={68}
        style={{ left: 990, top: 96 }}
      />
      <div style={{ position: 'absolute', left: 1010, top: 548 }}>
        <LedScreen cell={20} eyes={{ mood: 'happy' }} status="LEARNING" statusColor={C.accent} readout="2 NEW" />
      </div>
    </Poster>
  )
}
