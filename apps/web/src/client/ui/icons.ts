import {
  BadgeCheck,
  BadgeQuestionMark,
  BadgeX,
  Brain,
  Container,
  Cpu,
  Feather,
  Gavel,
  KeyRound,
  ListFilter,
  LockKeyhole,
  MessagesSquare,
  MonitorSmartphone,
  ScreenShare,
  ScrollText,
  Server,
  ServerCog,
  ShieldCheck,
  ShieldQuestion,
  Zap,
} from 'lucide-react'

/**
 * One glyph per feature. A glyph listed here means its feature wherever it appears, so screens take it from here,
 * never from lucide-react directly; tests/icons.test.ts fails when two features share a glyph or a screen imports one
 * of these on its own. A feature can have more than one entry (the reviewer and its verdicts); a glyph cannot.
 */
export const FEATURE_ICONS = {
  /** What agents did with the person's files and machine, in the workspace's Audit view. */
  audit: ScrollText,
  /** What agents may do in a project folder. */
  permissions: ShieldCheck,
  /** A project that asks before acting, and the approvals it waits on. */
  approvalAsk: ShieldQuestion,
  /** A project where agents act without asking. */
  autonomous: Zap,
  /** Per-tool allow, ask and off rules in Settings → Tools. */
  toolRules: ListFilter,
  /** The sandbox shell commands run in. */
  sandbox: Container,
  /** The independent reviewer, in Settings and the crew's events. */
  reviewer: Gavel,
  /** A review's verdict, and the reviewer checking every answer. */
  verdict: BadgeCheck,
  /** The reviewer when the lead asks for it. */
  reviewAuto: BadgeQuestionMark,
  /** No reviewer. */
  reviewOff: BadgeX,
  /** Extended thinking: a model that thinks, how hard the lead thinks, its thoughts. */
  thinking: Brain,
  /** The lightest thinking effort. */
  lightThinking: Feather,
  /** Models: the Models section, the /model command. */
  models: Cpu,
  /** Providers and their keys. */
  providers: KeyRound,
  /** Another Myrmidon this window can show. */
  gateway: Server,
  /** Managing gateways. */
  gateways: ServerCog,
  /** Devices paired with this gateway, and pairing one. */
  devices: MonitorSmartphone,
  /** An agent's computer: the browser and desktop it drives. */
  computer: ScreenShare,
  /** Messaging channels (Telegram and the rest). */
  channels: MessagesSquare,
  /** An agent asking the person to sign in to a website for it. */
  siteSignIn: LockKeyhole,
} as const
