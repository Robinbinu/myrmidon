import type { CSSProperties } from 'react'

/** Line icons drawn for the film on a 24-unit grid; generic shapes only, never a company's mark. */
const PATHS = {
  terminal: ['M4 5h16v14H4z', 'M7.5 9.5l3 2.5-3 2.5', 'M13 15h4'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z'],
  mic: ['M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  message: ['M4 5h16v11H10l-6 4z'],
  search: ['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M20 20l-4.6-4.6'],
  calendar: ['M4 6h16v14H4z', 'M4 10.5h16', 'M8.5 3.5v4', 'M15.5 3.5v4'],
  workflow: ['M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M18 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M12 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M8.5 6h7', 'M7.2 8.2l3.6 7.4', 'M16.8 8.2l-3.6 7.4'],
  pointer: ['M5 3.5l13 6.2-5.6 1.9-1.9 5.6z', 'M12.6 12.4l5 5'],
  hash: ['M5 9h14', 'M5 15h14', 'M10.5 4l-2 16', 'M15.5 4l-2 16'],
  router: ['M3 7h4.5l9 10H21', 'M3 17h4.5l2.6-2.9', 'M13.9 9.9L16.5 7H21', 'M18.5 4.5L21 7l-2.5 2.5', 'M18.5 14.5L21 17l-2.5 2.5'],
  shield: ['M12 3l7.5 3v5.5c0 4.8-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.7-7.5-9.5V6z', 'M8.8 12.2l2.2 2.2 4.4-4.6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  arrowUp: ['M12 19V5.5', 'M6.5 11l5.5-5.5 5.5 5.5'],
  users: ['M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M2.5 20c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2', 'M15.5 4.7a3.4 3.4 0 0 1 0 6.6', 'M18 14.1c2.1.8 3.5 2.9 3.5 5.9'],
  branch: ['M6 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M6 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M18 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M6 7.5v9', 'M18 10c0 4.2-5.6 3.6-11.2 7'],
  folder: ['M3.5 6.5h6l2 2.5h9v10h-17z'],
  zap: ['M13 3L5 13.5h6.5L10.5 21 19 10.5h-6.5z'],
  paperclip: ['M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9'],
  phone: ['M5.2 3.8h3.6l1.9 4.8-2.4 1.5a11 11 0 0 0 5.6 5.6l1.5-2.4 4.8 1.9v3.6a2 2 0 0 1-2 2A16.4 16.4 0 0 1 3.2 5.8a2 2 0 0 1 2-2z'],
  lock: ['M6 10.5h12V20H6z', 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'],
  monitor: ['M3.5 4.5h17v11.5h-17z', 'M9 20h6', 'M12 16v4'],
  code: ['M8.5 7L3.5 12l5 5', 'M15.5 7l5 5-5 5', 'M13.5 4.5l-3 15'],
  file: ['M6 3.5h8l4 4V20.5H6z', 'M14 3.5V7.5h4'],
  wallet: ['M4 6.5h14.5v13H4z', 'M4 6.5l11-3v3', 'M14.5 13h4'],
  log: ['M5 4.5h14v15H5z', 'M8.5 8.5h7', 'M8.5 12h7', 'M8.5 15.5h4.5'],
  star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z'],
  x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  sparkle: ['M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5z'],
  layers: ['M12 4l8.5 4.5L12 13 3.5 8.5z', 'M3.5 12.5L12 17l8.5-4.5', 'M3.5 16.2L12 20.7l8.5-4.5'],
} as const

export type IconName = keyof typeof PATHS

export function Icon(props: { name: IconName; size?: number; color?: string; stroke?: number; fill?: string; style?: CSSProperties }) {
  const size = props.size ?? 24
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={props.fill ?? 'none'}
      stroke={props.color ?? 'currentColor'}
      strokeWidth={props.stroke ?? 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0, ...props.style }}
    >
      {PATHS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
