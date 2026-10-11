import type { CSSProperties, ReactNode } from 'react'
import { RADIUS, SHADOW, SPACE } from '../design.ts'
import { C } from '../theme.ts'
import { T } from './Text.tsx'

export const PHONE_W = 440
export const PHONE_H = Math.round(PHONE_W * 2.06)
const BEZEL = 13
/** The screen's inner size; screens lay themselves out in it. */
export const SCREEN_W = PHONE_W - BEZEL * 2
export const SCREEN_H = PHONE_H - BEZEL * 2
/** Where the status bar ends and an app's content can start. */
export const SCREEN_TOP = 64

/** Alex's phone: a dark bezel with an island, a status bar, and whatever screen it is given. */
export function Phone(props: { children: ReactNode; style?: CSSProperties; screenBg?: string }) {
  return (
    <div
      style={{
        width: PHONE_W,
        height: PHONE_H,
        borderRadius: 70,
        padding: BEZEL,
        background: 'linear-gradient(145deg, #2c2c32 0%, #121215 40%, #1d1d22 100%)',
        boxShadow: `0 0 0 1px rgba(255,255,255,0.12), inset 0 0 0 1.5px rgba(255,255,255,0.06), ${SHADOW.lg}`,
        ...props.style,
      }}
    >
      <div
        data-box=""
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: 58,
          overflow: 'hidden',
          background: props.screenBg ?? '#0a0a0c',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            width: 124,
            height: 36,
            marginLeft: -62,
            borderRadius: RADIUS.pill,
            background: '#000',
            zIndex: 5,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: SPACE[8] + SPACE[3],
            right: SPACE[8],
            height: 28,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            zIndex: 4,
          }}
        >
          <T role="label" weight="semibold">
            23:12
          </T>
          <span style={{ display: 'flex', gap: 3, alignItems: 'flex-end' }}>
            {[0.45, 0.6, 0.8, 1].map((b) => (
              <span key={b} style={{ width: 4, height: 13 * b, background: C.label, borderRadius: 1 }} />
            ))}
            <span
              style={{
                marginLeft: SPACE[2],
                width: 26,
                height: 13,
                borderRadius: 4,
                boxShadow: `inset 0 0 0 1.5px ${C.label3}`,
                padding: 2,
                display: 'flex',
              }}
            >
              <span style={{ flex: 0.8, background: C.label, borderRadius: 2 }} />
            </span>
          </span>
        </div>
        {props.children}
      </div>
    </div>
  )
}
