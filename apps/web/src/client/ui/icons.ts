import {
  Activity,
  AudioLines,
  BadgeCheck,
  BadgeQuestionMark,
  BadgeX,
  BookMarked,
  Brain,
  CalendarClock,
  Container,
  Cpu,
  Feather,
  FileCode,
  FishingHook,
  Gavel,
  GitBranch,
  Globe,
  GraduationCap,
  Keyboard,
  KeyRound,
  ListChecks,
  ListFilter,
  LockKeyhole,
  Mail,
  MessageSquareText,
  MessagesSquare,
  MonitorSmartphone,
  Palette,
  PhoneIncoming,
  Plug,
  Puzzle,
  ScreenShare,
  ScrollText,
  Server,
  ServerCog,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  Smile,
  SquareTerminal,
  Terminal,
  User,
  UserCog,
  UserRoundPlus,
  Users,
  UsersRound,
  Waypoints,
  Workflow,
  Wrench,
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
  /** The crew: everyone on a chat's team, the Crew settings, the /team command. */
  crew: Users,
  /** Helpers the lead brings in, and the setting for them. */
  helpers: UsersRound,
  /** Helpers when the lead decides it needs them. */
  helpersAuto: UserRoundPlus,
  /** The lead working alone, no helpers. */
  solo: User,
  /** A lead assigning work: the orchestrated mode, the /mode command. */
  orchestrated: Workflow,
  /** Equal peers sharing one plan: the swarm mode. */
  swarm: Waypoints,
  /** House rules every agent follows (Settings → Instructions). */
  instructions: MessageSquareText,
  /** Agents writing to each other: the Mail view, mail events, the messaging tools. */
  mail: Mail,
  /** MCP servers and their tools. */
  mcp: Plug,
  /** Specialists the person keeps. */
  specialists: UserCog,
  /** What agents remember across chats. */
  memory: BookMarked,
  /** Skills: playbooks agents load, learn and propose. */
  skills: GraduationCap,
  /** Tools agents call, the tool library and tools they make. */
  tools: Wrench,
  /** Plugins and the views they add. */
  plugins: Puzzle,
  /** Hooks: commands around every tool call. */
  hooks: FishingHook,
  /** Requests that run on a schedule. */
  schedules: CalendarClock,
  /** How the app looks: Settings → General. */
  appearance: Palette,
  /** The mascot and the person's name. */
  mascot: Smile,
  /** Voice calls with the crew. */
  voice: AudioLines,
  /** Phone calls on the SMS channel's Twilio number, and a call card that was one. */
  phoneCalls: PhoneIncoming,
  /** The web: search, fetching pages, a page an agent opened. */
  web: Globe,
  /** Scratch files: private drafts before publishing. */
  scratchFiles: SlidersHorizontal,
  /** Files the crew published. */
  files: FileCode,
  /** The project's git history. */
  git: GitBranch,
  /** Tasks on the crew's board. */
  tasks: ListChecks,
  /** The person's own shell in the workspace. */
  personalShell: Terminal,
  /** Commands agents run in their sandbox. */
  agentShell: SquareTerminal,
  /** The live record of what the crew did. */
  activity: Activity,
  /** Keyboard shortcuts: the shortcuts sheet (⌘/) and its list in Settings. */
  shortcuts: Keyboard,
} as const
