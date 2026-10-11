import {
  Activity,
  AppWindow,
  AudioLines,
  AudioWaveform,
  BadgeCheck,
  BadgeQuestionMark,
  BadgeX,
  Battery,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BellRing,
  BookMarked,
  Brain,
  Bug,
  Cable,
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
  Footprints,
  Gavel,
  GitBranch,
  Glasses,
  Globe,
  Goal,
  GraduationCap,
  HandHelping,
  HeartHandshake,
  ImagePlus,
  Import,
  Keyboard,
  KeyRound,
  LifeBuoy,
  ListChecks,
  ListFilter,
  ListTree,
  LockKeyhole,
  Mail,
  MessageSquareText,
  MessagesSquare,
  MonitorSmartphone,
  MousePointerClick,
  OctagonPause,
  PackageSearch,
  Palette,
  PhoneIncoming,
  Plug,
  Puzzle,
  RadioTower,
  RectangleEllipsis,
  RefreshCcwDot,
  Rocket,
  SatelliteDish,
  Scale,
  ScanSearch,
  ScreenShare,
  ScrollText,
  SearchCheck,
  Server,
  ServerCog,
  Share2,
  ShieldCheck,
  ShieldOff,
  ShieldPlus,
  ShieldQuestion,
  SlidersHorizontal,
  Smile,
  SquareTerminal,
  Star,
  Store,
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
  /** Prewalk: the lead plans, then hands off to its carry-out model (Settings → Crew & budget, the round's line). */
  prewalk: Footprints,
  /** Small jobs: the model that names chats and suggests memories (Settings → Crew & budget). */
  smallJobs: HandHelping,
  /** Goal mode: a round that keeps working until its goal holds (`/goal`, each check's line in the round). */
  goal: Goal,
  /** Stream rules: the person's rules that stop a reply mid-stream (`/rule`, the line a stop leaves in the round). */
  streamRules: OctagonPause,
  /** Models removed from pickers, listed under Hidden models in Settings → Models to restore. */
  hiddenModels: EyeOff,
  /** Providers and their keys. */
  providers: KeyRound,
  /** How close each subscription is to its plan's limits (Models & providers, the composer's model chip). */
  planLimits: BatteryMedium,
  /** The same battery, as full as the subscription the chosen model runs on (the composer's model chip). */
  planFull: BatteryFull,
  planLow: BatteryLow,
  planEmpty: Battery,
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
  /** Remote hosts agents reach over SSH: Settings → Tools, their rules and who may use them. */
  sshHosts: Cable,
  /** Sending finished runs to the person's own OTLP collector (Settings → General). */
  telemetry: SatelliteDish,
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
  /** Claude Code plugin marketplaces: catalogs to browse and install plugins from (Settings → Plugins). */
  marketplaces: Store,
  /** omp's skills registry: searching it and installing a skill (Settings → Skills). */
  skillRegistry: PackageSearch,
  /** The skill scanner's findings: in an install's review and under a flagged or held skill. */
  skillScan: ScanSearch,
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
  /** Pictures agents make and edit (generate_image): the image model in Settings → Tools. */
  imageGeneration: ImagePlus,
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
  /** Importing a Claude Code or Codex session into a new chat, and the imported transcript it starts from. */
  sessionImport: Import,
  /** A chat's family: the chat it was forked from and the chats forked from it, as a tree (Show family). */
  chatFamily: ListTree,
  /** Sharing a chat as an encrypted file the person sends, with its key apart. */
  shareFile: Share2,
  /** Sharing a chat live: inviting someone to watch or write in it (Share live), and the page they join. */
  liveShare: RadioTower,
  /** Checking GitHub for a newer Myrmidon release (Settings → About). */
  updates: RefreshCcwDot,
  /** Reporting a problem with Myrmidon on GitHub. */
  reportIssue: Bug,
  /** Starring Myrmidon's repository on GitHub. */
  starRepo: Star,
  /** Who made Myrmidon, and how to reach them. */
  creator: HeartHandshake,
  /** Myrmidon's license. */
  license: Scale,
} as const
