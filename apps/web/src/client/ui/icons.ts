import {
  Activity,
  AppWindow,
  AudioLines,
  AudioWaveform,
  BadgeCheck,
  BadgeQuestionMark,
  BadgeX,
  BellRing,
  BookMarked,
  Brain,
  CalendarClock,
  Compass,
  Container,
  Cpu,
  EyeOff,
  Feather,
  FileCode,
  FilePen,
  FileSearch,
  FileUp,
  FishingHook,
  FolderKey,
  FolderTree,
  Gavel,
  GitBranch,
  Glasses,
  Globe,
  GraduationCap,
  Keyboard,
  KeyRound,
  LifeBuoy,
  ListChecks,
  ListFilter,
  LockKeyhole,
  Mail,
  MessageSquareText,
  MessagesSquare,
  MonitorSmartphone,
  MousePointerClick,
  Palette,
  PhoneIncoming,
  Plug,
  Puzzle,
  RectangleEllipsis,
  Rocket,
  ScreenShare,
  ScrollText,
  SearchCheck,
  Server,
  ServerCog,
  ShieldCheck,
  ShieldOff,
  ShieldPlus,
  ShieldQuestion,
  SlidersHorizontal,
  Smile,
  SquareTerminal,
  Terminal,
  TextSearch,
  User,
  UserCheck,
  UserCog,
  UserRoundPlus,
  Users,
  UsersRound,
  Volume2,
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
  /** What agents may do: Settings → Permissions, a project's permissions, the chat's permission control. */
  permissions: ShieldCheck,
  /** The Ask preset, and the approvals agents wait on. */
  approvalAsk: ShieldQuestion,
  /** Answers remembered from approval cards ("don't ask again for …"). */
  chatGrants: ShieldPlus,
  /** The Auto preset: agents act without asking, within the sandbox. */
  autonomous: Zap,
  /** Allow, ask and deny rules under the presets. */
  toolRules: ListFilter,
  /** Who can use what: tool groups for the lead and the crew. */
  roleAccess: UserCheck,
  /** Checking which level and rule decide a tool's calls. */
  permissionCheck: SearchCheck,
  /** The file tools agents read and change files with, as a group the person can give or take away. */
  fileTools: FilePen,
  /** Folders sandboxed agents may read beyond the defaults: in Settings, a project's permissions, a chat's grants. */
  readAccess: FolderKey,
  /** Secrets kept from model providers: they see placeholders, never the keys (Settings → Permissions). */
  hiddenSecrets: RectangleEllipsis,
  /** The sandbox shell commands run in. */
  sandbox: Container,
  /** The Full access preset: agents run without the sandbox (its choice at any level, the badge on its chats). */
  fullAccess: ShieldOff,
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
  /** Fallback models: the ones an agent goes on with when its own fails (Settings → Crew & budget, the round's line). */
  fallback: LifeBuoy,
  /** The advisor: the model that watches agents' steps and sends one a note (Settings → Crew & budget, its notes). */
  advisor: Glasses,
  /** Models removed from pickers, listed under Hidden models in Settings → Models to restore. */
  hiddenModels: EyeOff,
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
  /** The person's own browser in the workspace, with tabs, kept apart from the agents' browsers. */
  browser: Compass,
  /** Computer use: agents controlling the person's own Mac (Settings → Computer use, its banner and steps). */
  computerUse: MousePointerClick,
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
  /** How the app feels on this device: Settings → General. */
  general: AppWindow,
  /** How the app looks: Settings → Appearance, its themes. */
  appearance: Palette,
  /** Importing a VS Code theme file. */
  themeImport: FileUp,
  /** The mascot and the person's name. */
  mascot: Smile,
  /** The mascot's sounds. */
  mascotSounds: Volume2,
  /** Voice calls with the crew. */
  voice: AudioLines,
  /** Voice providers (speech to text, voices, realtime models) and their keys, in Models & providers. */
  voiceProviders: AudioWaveform,
  /** Phone calls on the SMS channel's Twilio number, and a call card that was one. */
  phoneCalls: PhoneIncoming,
  /** The web: search, fetching pages, a page an agent opened. */
  web: Globe,
  /** Scratch files: private drafts before publishing. */
  scratchFiles: SlidersHorizontal,
  /** Files the crew published. */
  files: FileCode,
  /** The project folder as a tree in the workspace (Explorer). */
  explorer: FolderTree,
  /** A file in the chat's project folder, opened to read as it is now. */
  projectFile: FileSearch,
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
  /** The first-run setup assistant: running it again, and the home screen's card for what is left. */
  setup: Rocket,
  /** Notifications when a chat finishes or needs the person, and the Dock badge. */
  alerts: BellRing,
  /** Searching Settings: the field over the section list and its results. */
  settingsSearch: TextSearch,
} as const
