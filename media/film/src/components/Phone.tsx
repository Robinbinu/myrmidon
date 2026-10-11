import type { CSSProperties, ReactNode } from 'react'
import { C, FONT } from '../theme.ts'

/** A generic phone: a dark bezel with an island, a status bar, and whatever screen it is given. */
export function Phone(props: { width?: number; children: ReactNode; style?: CSSProperties; screenBg?: string }) {
  const w = props.width ?? 410
  const h = w * 2.06
  const bezel = w * 0.03
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: w * 0.16,
        padding: bezel,
        background: 'linear-gradient(145deg, #2c2c32 0%, #121215 40%, #1d1d22 100%)',
        boxShadow:
          '0 0 0 1px rgba(255,255,255,0.12), inset 0 0 0 1.5px rgba(255,255,255,0.06), 0 60px 120px -30px rgba(0,0,0,0.95), 0 30px 50px -30px rgba(0,0,0,0.9)',
        ...props.style,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: w * 0.135,
          overflow: 'hidden',
          background: props.screenBg ?? '#0a0a0c',
          fontFamily: FONT,
          color: C.label,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: w * 0.028,
            left: '50%',
            width: w * 0.3,
            height: w * 0.085,
            marginLeft: -w * 0.15,
            borderRadius: 99,
            background: '#000',
            zIndex: 5,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: w * 0.04,
            left: w * 0.09,
            right: w * 0.08,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: w * 0.04,
            fontWeight: 650,
            zIndex: 4,
          }}
        >
          <span>9:41</span>
          <span style={{ display: 'flex', gap: w * 0.012, alignItems: 'center' }}>
            {[0.45, 0.6, 0.8, 1].map((b) => (
              <span key={b} style={{ width: w * 0.008, height: w * 0.03 * b, background: C.label, borderRadius: 2 }} />
            ))}
            <span
              style={{
                marginLeft: w * 0.02,
                width: w * 0.062,
                height: w * 0.03,
                borderRadius: w * 0.008,
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
