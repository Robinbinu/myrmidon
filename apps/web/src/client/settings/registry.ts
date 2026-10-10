import type { PermissionRule } from '@myrmidon/protocol'
import type { GatewayInfo, ModelOption, Specialist } from '../api.ts'
import { copy } from '../copy.ts'
import { type ACCESS_INFO, presetLabel, shownTarget } from '../permissions/describe.ts'
import type {
  ChannelView,
  DeviceRow,
  LoginOption,
  McpServer,
  PluginEntry,
  ProviderInfo,
  ScheduleEntry,
  SkillEntry,
} from '../Settings.tsx'
import { describeCron } from '../schedule-rule.ts'
import type { ThemeItem } from '../themes/AppearanceSection.tsx'
import { SUGGEST_MODEL_MB } from '../ui-config.ts'
import type { VoiceEndpointView, VoiceProviderView } from '../voice/providers.ts'
import type { ModelsTab, Section } from './pages.ts'

/**
 * What a settings row shows, so a test can check the row on screen has it: one switch, a segmented control, a pop-up
 * menu, a text field, a number, a text area or a slider; `choice` is a set of picture tiles or radio buttons. The
 * others hold several controls or none: `button` an action, `list` rows of things, `form` fields to add one, `info`
 * a value to read.
 */
export type Control =
  | 'switch'
  | 'segmented'
  | 'select'
  | 'text'
  | 'number'
  | 'textarea'
  | 'range'
  | 'choice'
  | 'button'
  | 'list'
  | 'form'
  | 'info'

interface Placed {
  page: Section
  /** The tab of Models & providers it is on. */
  tab?: ModelsTab
  /** The headings between the page and the row, as the page shows them: the breadcrumb's middle. */
  path?: readonly string[]
  control: Control
  /** Other words people use for it; never shown. */
  keywords?: readonly string[]
  /** Key paths of the runtime's settings file (packages/runtime/src/settings.ts) this row changes. */
  keys?: readonly string[]
  /** The row it is under, shown only once that one is on or set up: a jump that cannot find it shows that one. */
  dependsOn?: string
}

/** A setting with a row of its own: the row reads its label and hint from here. */
export interface StaticSetting extends Placed {
  label: string
  help?: string
}

/** What one live item adds to search: its row's key on the page, its name and a line about it. */
export interface DynamicItem {
  key: string
  label: string
  help?: string
  keywords?: readonly string[]
  /** Replaces the setting's path, for items grouped under headings of their own (a theme's Dark or Light). */
  path?: readonly string[]
}

/** The live lists rows are made from, as the pages load them; search loads the same ones (live.ts). */
export interface LiveData {
  providers: readonly ProviderInfo[]
  logins: readonly LoginOption[]
  models: readonly ModelOption[]
  /** The providers the model list groups by. */
  modelProviders: readonly string[]
  voiceProviders: readonly VoiceProviderView[]
  voiceEndpoints: readonly VoiceEndpointView[]
  themes: readonly ThemeItem[]
  accessGroups: typeof ACCESS_INFO
  rules: readonly PermissionRule[]
  mcpServers: readonly McpServer[]
  plugins: readonly PluginEntry[]
  specialists: readonly Specialist[]
  channels: readonly ChannelView[]
  gateways: readonly GatewayInfo[]
  devices: readonly DeviceRow[]
  schedules: readonly ScheduleEntry[]
  skills: readonly SkillEntry[]
}
export type LiveSource = keyof LiveData

/** A row per item of a live list (a provider, a model, an MCP server): search lists each item by its name. */
export interface DynamicSetting<S extends LiveSource> extends Placed {
  source: S
  item(x: LiveData[S][number]): DynamicItem
}

const dynamic = <S extends LiveSource>(
  source: S,
  e: Omit<DynamicSetting<S>, 'source'>,
): DynamicSetting<S> => ({
  source,
  ...e,
})

/** The strings of a copy object, for keywords: option names, the hints each value shows. */
const strings = (o: Record<string, unknown>): string[] =>
  Object.values(o).filter((v): v is string => typeof v === 'string')

const s = copy.settings
const kw = s.search.keywords
const g = s.general
const ap = s.appearance
const m = s.mascot
const v = s.voice
const ch = s.channels
const cu = copy.computerUse
const pr = s.providers
const vp = s.voiceProviders
const pm = copy.permissions
const mo = s.models
const cm = copy.composer

/**
 * Every setting Settings shows, by id: where it is, what it is called and what it says, and the other words people
 * use for it. Settings' rows render their label and hint from their entry here (settings/Setting.tsx), so search
 * reads what the screen shows. Adding or moving a setting is adding or changing its entry; the settings registry
 * tests fail on a control without one, an entry no page shows, and a settings key no entry claims.
 */
export const SETTINGS = {
  // General
  'general.reduceMotion': {
    page: 'general',
    control: 'switch',
    label: g.reduceMotion,
    help: g.reduceMotionHint,
    keywords: kw.motion,
  },
  'general.notifications': {
    page: 'general',
    control: 'switch',
    label: s.notify.label,
    help: s.notify.hint,
    keywords: kw.notifications,
  },
  'general.chatNames': {
    page: 'general',
    control: 'segmented',
    label: m.titles,
    help: m.titlesHints.model,
    keywords: [...kw.chatNames, m.titlesModel, m.titlesFirst, m.titlesHints['first-message']],
    keys: ['profile.titles'],
  },
  'general.suggest': {
    page: 'general',
    control: 'switch',
    label: g.suggest,
    help: g.suggestHint,
    keywords: kw.suggest,
  },
  'general.suggestModel': {
    page: 'general',
    control: 'switch',
    label: g.suggestModel,
    help: g.suggestModelHint(SUGGEST_MODEL_MB),
    keywords: [...kw.suggest, 'next word', 'language model', 'pythia', 'autocomplete'],
    dependsOn: 'general.suggest',
  },
  'general.setup': {
    page: 'general',
    control: 'button',
    label: g.setup,
    help: g.setupHint,
    keywords: [g.runSetup, ...kw.setup],
  },
  'general.setupStep': {
    page: 'general',
    control: 'button',
    label: g.setupStep,
    help: g.setupStepHint,
    keywords: strings(copy.setup.steps),
  },
  'general.shortcuts': {
    page: 'general',
    control: 'list',
    label: s.shortcuts.title,
    keywords: [...kw.shortcuts, ...strings(s.shortcuts)],
  },
  'general.dataFolder': {
    page: 'general',
    path: [s.about.title],
    control: 'info',
    label: s.about.dataDirectory,
    keywords: kw.dataFolder,
  },
  'general.providersReady': {
    page: 'general',
    path: [s.about.title],
    control: 'info',
    label: s.about.providersReady,
    help: s.about.providersReadyHint,
  },
  'general.sandbox': {
    page: 'general',
    path: [s.about.title],
    control: 'info',
    label: s.about.sandbox,
  },

  // Appearance
  'appearance.myrmidon': {
    page: 'appearance',
    path: [ap.gallery],
    control: 'choice',
    label: ap.groups.myrmidon,
    help: ap.myrmidonHint,
    keywords: [...kw.theme, ...kw.system],
  },
  'appearance.dark': {
    page: 'appearance',
    path: [ap.gallery],
    control: 'choice',
    label: ap.groups.dark,
    keywords: kw.vscodeThemes,
  },
  'appearance.light': {
    page: 'appearance',
    path: [ap.gallery],
    control: 'choice',
    label: ap.groups.light,
    keywords: kw.vscodeThemes,
  },
  'appearance.imported': {
    page: 'appearance',
    path: [ap.gallery],
    control: 'list',
    label: ap.groups.imported,
    help: ap.noImported,
    keywords: kw.importTheme,
    keys: ['appearance.imported'],
  },
  'appearance.import': {
    page: 'appearance',
    control: 'form',
    label: ap.importTitle,
    help: ap.importHint,
    keywords: kw.importTheme,
    keys: ['appearance.imported'],
  },

  // You & mascot
  'mascot.name': {
    page: 'mascot',
    control: 'text',
    label: m.name,
    keywords: kw.name,
    keys: ['profile.name'],
  },
  'mascot.greeting': {
    page: 'mascot',
    control: 'segmented',
    label: m.greeting,
    help: m.greetingHints.model,
    keywords: [...kw.greeting, m.greetingModel, m.greetingRules, m.greetingHints.rules],
    keys: ['profile.greeting'],
  },
  'mascot.preview': { page: 'mascot', control: 'info', label: m.livePreview, keywords: kw.mascot },
  'mascot.eyes': {
    page: 'mascot',
    control: 'choice',
    label: m.eyes,
    keywords: [...kw.mascot, ...strings(m.eyeStyles)],
    keys: ['mascot.eyes'],
  },
  'mascot.look': {
    page: 'mascot',
    control: 'choice',
    label: m.look,
    keywords: strings(m.looks),
    keys: ['mascot.look'],
  },
  'mascot.color': {
    page: 'mascot',
    control: 'choice',
    label: m.color,
    keywords: [...kw.colour, ...strings(m.colors)],
    keys: ['mascot.color'],
  },
  'mascot.screen': {
    page: 'mascot',
    control: 'segmented',
    label: m.screen,
    keywords: strings(m.screens),
    keys: ['mascot.screen'],
  },
  'mascot.idle': {
    page: 'mascot',
    path: [m.liveliness],
    control: 'segmented',
    label: m.idle,
    keywords: strings(m.idleLevels),
    keys: ['mascot.idle'],
  },
  'mascot.shows': { page: 'mascot', path: [m.liveliness], control: 'list', label: m.shows },
  'mascot.show.pacman': {
    page: 'mascot',
    path: [m.liveliness, m.shows],
    control: 'switch',
    label: m.showNames.pacman,
    help: m.showHints.pacman,
    keys: ['mascot.shows.pacman'],
  },
  'mascot.show.life': {
    page: 'mascot',
    path: [m.liveliness, m.shows],
    control: 'switch',
    label: m.showNames.life,
    help: m.showHints.life,
    keys: ['mascot.shows.life'],
  },
  'mascot.show.confetti': {
    page: 'mascot',
    path: [m.liveliness, m.shows],
    control: 'switch',
    label: m.showNames.confetti,
    help: m.showHints.confetti,
    keys: ['mascot.shows.confetti'],
  },
  'mascot.show.boot': {
    page: 'mascot',
    path: [m.liveliness, m.shows],
    control: 'switch',
    label: m.showNames.boot,
    help: m.showHints.boot,
    keys: ['mascot.shows.boot'],
  },
  'mascot.temper': {
    page: 'mascot',
    path: [m.liveliness],
    control: 'segmented',
    label: m.temper,
    keywords: [...strings(m.tempers), ...strings(m.temperHints)],
    keys: ['mascot.temper'],
  },
  'mascot.crew.show': {
    page: 'mascot',
    path: [m.crew],
    control: 'switch',
    label: m.crewShow,
    keywords: [m.crewHint],
    keys: ['mascot.crew.show'],
  },
  'mascot.crew.count': {
    page: 'mascot',
    path: [m.crew],
    control: 'segmented',
    label: m.crewCount,
    dependsOn: 'mascot.crew.show',
    keys: ['mascot.crew.count'],
  },
  'mascot.crew.names': {
    page: 'mascot',
    path: [m.crew],
    control: 'segmented',
    label: m.crewNames,
    keywords: [...strings(m.crewSources), ...strings(m.crewSourceHints)],
    dependsOn: 'mascot.crew.show',
    keys: ['mascot.crew.names'],
  },
  'mascot.crew.custom': {
    page: 'mascot',
    path: [m.crew],
    control: 'text',
    label: m.crewCustom,
    dependsOn: 'mascot.crew.names',
    keys: ['mascot.crew.custom'],
  },
  'mascot.crew.boldness': {
    page: 'mascot',
    path: [m.crew],
    control: 'segmented',
    label: m.boldness,
    keywords: [...strings(m.boldnessLevels), ...strings(m.boldnessHints)],
    dependsOn: 'mascot.crew.show',
    keys: ['mascot.crew.boldness'],
  },
  'mascot.display.dots': {
    page: 'mascot',
    path: [m.display],
    control: 'segmented',
    label: m.dots,
    keywords: strings(m.dotShapes),
    keys: ['mascot.display.dots'],
  },
  'mascot.display.grid': {
    page: 'mascot',
    path: [m.display],
    control: 'segmented',
    label: m.grid,
    keywords: strings(m.grids),
    keys: ['mascot.display.grid'],
  },
  'mascot.display.glow': {
    page: 'mascot',
    path: [m.display],
    control: 'segmented',
    label: m.glow,
    keywords: strings(m.glows),
    keys: ['mascot.display.glow'],
  },
  'mascot.display.eyeColor': {
    page: 'mascot',
    path: [m.display],
    control: 'segmented',
    label: m.eyeColor,
    keywords: [...kw.colour, ...strings(m.eyeColors), ...strings(m.eyeColorHints)],
    keys: ['mascot.display.eyeColor'],
  },
  'mascot.display.size': {
    page: 'mascot',
    path: [m.display],
    control: 'segmented',
    label: m.size,
    keywords: strings(m.sizes),
    keys: ['mascot.display.size'],
  },
  'mascot.sounds.enabled': {
    page: 'mascot',
    path: [m.sounds],
    control: 'switch',
    label: m.soundsOn,
    keywords: kw.sounds,
    keys: ['mascot.sounds.enabled'],
  },
  'mascot.sounds.reactions': {
    page: 'mascot',
    path: [m.sounds],
    control: 'switch',
    label: m.soundReactions,
    dependsOn: 'mascot.sounds.enabled',
    keys: ['mascot.sounds.reactions'],
  },
  'mascot.sounds.typing': {
    page: 'mascot',
    path: [m.sounds],
    control: 'switch',
    label: m.soundTyping,
    dependsOn: 'mascot.sounds.enabled',
    keys: ['mascot.sounds.typing'],
  },
  'mascot.sounds.volume': {
    page: 'mascot',
    path: [m.sounds],
    control: 'segmented',
    label: m.volume,
    keywords: [...strings(m.volumes), m.testSound, ...kw.sounds],
    dependsOn: 'mascot.sounds.enabled',
    keys: ['mascot.sounds.volume'],
  },

  // Specialists
  'specialists.add': {
    page: 'specialists',
    control: 'form',
    label: s.specialists.add,
    help: s.specialists.emptyHint,
    keywords: kw.specialists,
  },

  // Devices
  'devices.scope': {
    page: 'devices',
    control: 'segmented',
    label: s.devices.scope,
    keywords: [...kw.devices, ...strings(s.devices.scopes), ...strings(s.devices.scopeHints)],
  },
  'devices.pair': { page: 'devices', control: 'button', label: s.devices.pair, keywords: kw.devices },

  // Gateways
  'gateways.link': {
    page: 'gateways',
    path: [s.gateways.add],
    control: 'text',
    label: s.gateways.link,
    help: s.gateways.linkHint,
    keywords: kw.gateways,
  },
  'gateways.name': {
    page: 'gateways',
    path: [s.gateways.add],
    control: 'text',
    label: s.gateways.name,
    help: s.gateways.nameHint,
  },
  'gateways.add': { page: 'gateways', control: 'button', label: s.gateways.add, keywords: kw.gateways },

  // Channels: the page, then what each app's sheet shows once it is opened
  'channels.yours': { page: 'channels', control: 'list', label: ch.yours, keywords: kw.channels },
  'channels.add': {
    page: 'channels',
    control: 'list',
    label: ch.add,
    help: ch.addHint,
    keywords: kw.channels,
  },
  'channels.on': {
    page: 'channels',
    control: 'switch',
    label: ch.on,
    keywords: [ch.turnOn, ...kw.channels],
    dependsOn: 'channels.channel',
  },
  'channels.setup': {
    page: 'channels',
    control: 'form',
    label: ch.tabs.setup,
    keywords: kw.channelSetup,
    dependsOn: 'channels.channel',
  },
  'channels.project': {
    page: 'channels',
    path: [ch.tabs.setup],
    control: 'select',
    label: ch.project,
    help: ch.projectHint,
    dependsOn: 'channels.channel',
  },
  'channels.remove': {
    page: 'channels',
    path: [ch.tabs.setup],
    control: 'button',
    label: ch.remove,
    dependsOn: 'channels.channel',
  },
  'channels.requests': {
    page: 'channels',
    path: [ch.tabs.people],
    control: 'list',
    label: ch.waiting,
    help: ch.waitingHint,
    keywords: [ch.approve, ch.code],
    dependsOn: 'channels.channel',
  },
  'channels.people': {
    page: 'channels',
    path: [ch.tabs.people],
    control: 'list',
    label: ch.people,
    keywords: [ch.owner, ch.member, ch.revoke, ch.groups],
    dependsOn: 'channels.channel',
  },
  'channels.dm': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'select',
    label: ch.dm,
    help: ch.dmHint.pairing,
    keywords: strings(ch.dmOptions),
    dependsOn: 'channels.channel',
  },
  'channels.groups': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'select',
    label: ch.groupsLabel,
    help: ch.groupsHint.approve,
    keywords: strings(ch.groupsOptions),
    dependsOn: 'channels.channel',
  },
  'channels.mention': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'switch',
    label: ch.mention,
    help: ch.mentionHint,
    dependsOn: 'channels.channel',
  },
  'channels.perPerson': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'switch',
    label: ch.perPerson,
    help: ch.perPersonHint,
    dependsOn: 'channels.channel',
  },
  'channels.allow': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'text',
    label: ch.allow,
    help: ch.allowHint,
    keywords: ['allowlist', 'whitelist'],
    dependsOn: 'channels.channel',
  },
  'channels.stream': {
    page: 'channels',
    path: [ch.tabs.rules],
    control: 'select',
    label: ch.stream,
    help: ch.streamHint.progress,
    keywords: strings(ch.streamOptions),
    dependsOn: 'channels.channel',
  },

  // Voice
  'voice.enabled': {
    page: 'voice',
    control: 'switch',
    label: v.enabled,
    help: v.enabledHint({ detector: '', turn: '', kitten: '' }),
    keywords: kw.voice,
    keys: ['voice.enabled'],
  },
  'voice.mode': {
    page: 'voice',
    control: 'segmented',
    label: v.mode,
    help: v.modeHints.pipeline,
    keywords: [...strings(v.modes), v.modeHints.realtime, ...kw.realtime],
    dependsOn: 'voice.enabled',
    keys: ['voice.mode'],
  },
  'voice.callModel': {
    page: 'voice',
    control: 'segmented',
    label: v.callModel,
    help: v.callModelHint,
    keywords: [v.sameAsLead, v.ownModel],
    dependsOn: 'voice.enabled',
    keys: ['voice.callModel'],
  },
  'voice.sensitivity': {
    page: 'voice',
    control: 'select',
    label: v.sensitivity,
    help: v.sensitivityHint,
    keywords: [...kw.mic, ...strings(v.sensitivities)],
    dependsOn: 'voice.enabled',
    keys: ['voice.sensitivity'],
  },
  'voice.realtime.provider': {
    page: 'voice',
    path: [v.realtimeTitle],
    control: 'select',
    label: v.realtimeProvider,
    keywords: kw.realtime,
    dependsOn: 'voice.mode',
    keys: ['voice.realtime.provider'],
  },
  'voice.realtime.model': {
    page: 'voice',
    path: [v.realtimeTitle],
    control: 'select',
    label: v.realtimeModel,
    dependsOn: 'voice.realtime.provider',
    keys: ['voice.realtime.model'],
  },
  'voice.realtime.voice': {
    page: 'voice',
    path: [v.realtimeTitle],
    control: 'select',
    label: v.realtimeVoice,
    dependsOn: 'voice.realtime.provider',
    keys: ['voice.realtime.voice'],
  },
  'voice.addProvider': {
    page: 'voice',
    control: 'button',
    label: v.addProvider,
    help: v.addProviderHint,
    keywords: kw.voiceProviders,
    dependsOn: 'voice.enabled',
  },
  'voice.stt.engine': {
    page: 'voice',
    path: [v.sttTitle],
    control: 'select',
    label: v.engineLabel,
    keywords: [...kw.stt, ...strings(v.providers)],
    dependsOn: 'voice.enabled',
    keys: ['voice.stt.provider'],
  },
  'voice.stt.model': {
    page: 'voice',
    path: [v.sttTitle],
    control: 'select',
    label: v.model,
    dependsOn: 'voice.stt.engine',
    keys: ['voice.stt.model'],
  },
  'voice.stt.endpointModel': {
    page: 'voice',
    path: [v.sttTitle],
    control: 'text',
    label: v.endpointModel,
    dependsOn: 'voice.stt.engine',
    keys: ['voice.stt.model'],
  },
  'voice.tts.engine': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.engineLabel,
    keywords: [...kw.tts, ...strings(v.providers)],
    dependsOn: 'voice.enabled',
    keys: ['voice.tts.provider'],
  },
  'voice.tts.kittenModel': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.kittenModel,
    keywords: [v.providers.kitten, ...strings(v.kittenModels)],
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.kittenModel'],
  },
  'voice.tts.voice': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.voice,
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.voice'],
  },
  'voice.tts.model': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.model,
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.model'],
  },
  'voice.tts.voiceId': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.voice,
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.voiceId'],
  },
  'voice.tts.endpointModel': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'text',
    label: v.endpointModel,
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.model'],
  },
  'voice.tts.endpointVoice': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'text',
    label: v.endpointVoice,
    dependsOn: 'voice.tts.engine',
    keys: ['voice.tts.voiceId'],
  },
  'voice.tts.speed': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'select',
    label: v.speed,
    keywords: ['rate', 'faster', 'slower', 'speaking speed'],
    dependsOn: 'voice.enabled',
    keys: ['voice.tts.speed'],
  },
  'voice.tts.try': {
    page: 'voice',
    path: [v.ttsTitle],
    control: 'button',
    label: v.tryIt,
    keywords: ['test voice', 'sample', 'preview voice'],
    dependsOn: 'voice.enabled',
  },
  'voice.phone.enabled': {
    page: 'voice',
    path: [v.phone.title],
    control: 'switch',
    label: v.phone.enabled,
    help: v.phone.hint,
    keywords: kw.phone,
    dependsOn: 'voice.enabled',
    keys: ['voice.phone'],
  },
  'voice.phone.callMe': {
    page: 'voice',
    path: [v.phone.title],
    control: 'button',
    label: v.phone.callMe,
    help: v.phone.callMeHint,
    dependsOn: 'voice.phone.enabled',
  },

  // Computer use
  'computer.enabled': {
    page: 'computer',
    control: 'switch',
    label: cu.switchLabel,
    help: cu.switchHint,
    keywords: kw.computer,
    keys: ['computerUse.enabled'],
  },
  'computer.engine': {
    page: 'computer',
    control: 'segmented',
    label: cu.engineTitle,
    help: cu.engineNote,
    keywords: [cu.engines.cua.label, cu.engines.omp.label, cu.engines.cua.hint, cu.engines.omp.hint],
    keys: ['computerUse.engine'],
  },
  'computer.driver': {
    page: 'computer',
    control: 'button',
    label: cu.driverTitle,
    help: cu.driverNote,
    dependsOn: 'computer.engine',
  },
  'computer.grant.screenRecording': {
    page: 'computer',
    path: [cu.grantsTitle],
    control: 'button',
    label: cu.grants.screenRecording.label,
    help: cu.grants.screenRecording.hint,
    keywords: ['macos permission', 'privacy'],
  },
  'computer.grant.accessibility': {
    page: 'computer',
    path: [cu.grantsTitle],
    control: 'button',
    label: cu.grants.accessibility.label,
    help: cu.grants.accessibility.hint,
    keywords: ['macos permission', 'privacy'],
  },
  'computer.restart': {
    page: 'computer',
    path: [cu.grantsTitle],
    control: 'button',
    label: cu.restart,
    help: cu.restartNote,
    dependsOn: 'computer.engine',
  },
  'computer.tiers': { page: 'computer', control: 'info', label: cu.tiersTitle },
  'computer.apps': { page: 'computer', control: 'list', label: cu.appsTitle, help: cu.appsNote },

  // Models & providers: its two tabs, then each tab's rows
  'models.tabs': {
    page: 'models',
    tab: 'providers',
    control: 'segmented',
    label: s.page.providersTab,
    keywords: [s.page.modelsTab, ...kw.apiKey],
  },
  // Models & providers → Your models
  'models.filter': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'text',
    label: mo.search,
    keywords: kw.models,
  },
  'models.expandAll': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'button',
    label: mo.expandAll,
    keywords: ['open every provider', 'show all models', 'unfold'],
  },
  'models.collapseAll': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'button',
    label: mo.collapseAll,
    keywords: ['close every provider', 'hide model lists', 'fold'],
  },
  'models.refresh': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'button',
    label: mo.refresh,
    keywords: ['reload models', 'update model list'],
  },
  'models.add': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'button',
    label: mo.addModels,
    keywords: kw.models,
  },
  'models.hidden': {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'list',
    label: mo.hiddenTitle,
    keywords: [mo.restore],
    keys: ['models.hidden'],
  },

  // Models & providers → Keys & providers
  'providers.import': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab],
    control: 'button',
    label: pr.importTitle,
    help: pr.importHint,
    keywords: ['omp', 'oh-my-pi', ...kw.apiKey],
  },
  'providers.signIns': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab],
    control: 'list',
    label: s.signIns.title,
    help: s.signIns.subtitle,
    keywords: kw.subscription,
  },
  'providers.list': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab],
    control: 'list',
    label: pr.heading,
    keywords: kw.apiKey,
    keys: ['models.hiddenProviders'],
  },
  'providers.custom': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, pr.heading],
    control: 'form',
    label: pr.customEndpoint,
    keywords: kw.customEndpoint,
  },
  'voiceProviders.list': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab],
    control: 'list',
    label: vp.heading,
    help: vp.intro,
    keywords: [...kw.voiceProviders, ...kw.apiKey],
  },
  'voiceProviders.endpoints': {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, vp.heading],
    control: 'form',
    label: vp.endpoints.heading,
    help: vp.endpoints.note,
    keywords: [vp.endpoints.add, 'whisper', 'kokoro', 'piper'],
    keys: ['voice.endpoints'],
  },

  // Crew & budget
  'team.lead': {
    page: 'team',
    path: [s.team.crewTitle],
    control: 'button',
    label: cm.lead,
    help: cm.leadHint,
    keywords: kw.leadModel,
    keys: ['team.leadModel'],
  },
  'team.reviewerModel': {
    page: 'team',
    path: [s.team.crewTitle],
    control: 'button',
    label: cm.reviewer,
    help: cm.reviewerHint.unknown,
    keywords: kw.reviewer,
    keys: ['team.judgeModel'],
  },
  'team.thinking': {
    page: 'team',
    path: [s.team.crewTitle],
    control: 'segmented',
    label: cm.thinkingLabel,
    help: cm.thinkingHint,
    keywords: ['reasoning', 'effort', ...strings(cm.thinking)],
  },
  'team.helpers': {
    page: 'team',
    path: [s.team.crewTitle],
    control: 'segmented',
    label: cm.helpers,
    keywords: kw.helpers,
    keys: ['team.workers'],
  },
  'team.helperList': {
    page: 'team',
    path: [s.team.crewTitle],
    control: 'list',
    label: cm.helperList,
    keywords: [
      copy.teamControls.editor.style,
      copy.teamControls.editor.orchestrated,
      copy.teamControls.editor.swarm,
    ],
    dependsOn: 'team.helpers',
    keys: ['team.mode', 'team.workerModel'],
  },
  'team.wallMinutes': {
    page: 'team',
    path: [s.team.limitsTitle],
    control: 'number',
    label: s.team.timeLimit,
    help: s.team.timeLimitHint,
    keywords: kw.time,
    keys: ['team.wallMinutes'],
  },
  'team.costUsd': {
    page: 'team',
    path: [s.team.limitsTitle],
    control: 'number',
    label: s.team.spendLimit,
    help: s.team.spendLimitHint,
    keywords: kw.budget,
    keys: ['team.costUsd'],
  },
  'team.tokens': {
    page: 'team',
    path: [s.team.limitsTitle],
    control: 'number',
    label: s.team.tokenLimit,
    help: s.team.tokenLimitHint,
    keywords: ['token budget', ...kw.budget],
    keys: ['team.tokens'],
  },
  'team.maxTurns': {
    page: 'team',
    path: [s.team.limitsTitle],
    control: 'number',
    label: s.team.turns,
    help: s.team.turnsHint,
    keywords: ['steps', 'iterations'],
    keys: ['team.maxTurns'],
  },
  'team.observer': {
    page: 'team',
    path: [s.team.limitsTitle],
    control: 'number',
    label: s.team.observer,
    help: s.team.observerHint,
    keywords: ['watchdog', 'stuck', 'idle'],
    keys: ['observer.intervalSeconds'],
  },
  'reviewer.when': {
    page: 'team',
    path: [s.reviewer.title],
    control: 'segmented',
    label: s.reviewer.when,
    help: s.reviewer.hints.auto,
    keywords: [...kw.reviewer, s.reviewer.auto, s.reviewer.always, s.reviewer.hints.always],
    keys: ['verification.reviewer'],
  },
  'reviewer.threshold': {
    page: 'team',
    path: [s.reviewer.title],
    control: 'range',
    label: s.reviewer.threshold,
    help: s.reviewer.thresholdHint,
    keywords: ['score', 'pass mark', ...kw.reviewer],
    keys: ['verification.threshold'],
  },
  'reviewer.rubric': {
    page: 'team',
    path: [s.reviewer.title],
    control: 'textarea',
    label: s.reviewer.rubric,
    help: s.reviewer.rubricHint,
    keywords: ['criteria', ...kw.reviewer],
    keys: ['verification.rubric'],
  },

  // Permissions
  'permissions.preset': {
    page: 'permissions',
    control: 'choice',
    label: pm.page.presetTitle,
    help: pm.page.presetNote,
    keywords: [
      ...kw.sandbox,
      ...(['read-only', 'ask', 'auto', 'full'] as const).flatMap((p) => [presetLabel(p), pm.presets[p].hint]),
    ],
    keys: ['permissions'],
  },
  'permissions.access': {
    page: 'permissions',
    control: 'list',
    label: pm.access.title,
    help: pm.access.note,
    keywords: kw.access,
    keys: ['permissions'],
  },
  'permissions.rules': {
    page: 'permissions',
    control: 'list',
    label: pm.rules.title,
    help: pm.rules.note,
    keywords: kw.rules,
    keys: ['permissions'],
  },
  'permissions.check': {
    page: 'permissions',
    control: 'list',
    label: pm.explain.title,
    help: pm.explain.note,
    keywords: ['test a tool', 'what happens', 'explain'],
  },
  'permissions.readHome': {
    page: 'permissions',
    path: [s.tools.reads.title],
    control: 'switch',
    label: s.tools.reads.home,
    help: s.tools.reads.homeHint,
    keywords: kw.readFolders,
    keys: ['sandbox.readHome'],
  },
  'permissions.readFolders': {
    page: 'permissions',
    path: [s.tools.reads.title],
    control: 'textarea',
    label: s.tools.reads.folders,
    keywords: kw.readFolders,
    keys: ['sandbox.read'],
  },

  // Instructions
  'instructions.lead': {
    page: 'instructions',
    control: 'textarea',
    label: s.instructions.lead,
    help: s.instructions.leadHint,
    keywords: kw.instructions,
    keys: ['instructions.lead'],
  },
  'instructions.workers': {
    page: 'instructions',
    control: 'textarea',
    label: s.instructions.workers,
    help: s.instructions.workersHint,
    keywords: kw.instructions,
    keys: ['instructions.worker'],
  },

  // Memory
  'memory.add': {
    page: 'memory',
    control: 'form',
    label: s.memory.remember,
    help: s.memory.rememberHint,
    keywords: kw.memory,
  },
  'memory.list': { page: 'memory', control: 'list', label: s.memory.listTitle, keywords: kw.memory },

  // Skills
  'skills.proposed': {
    page: 'skills',
    control: 'list',
    label: s.skills.proposedTitle,
    keywords: kw.skills,
  },
  'skills.archived': {
    page: 'skills',
    control: 'list',
    label: s.skills.archivedLabel,
    help: s.skills.archivedHint,
    keywords: [s.skills.restore, ...kw.skills],
  },

  // Tools
  'tools.mcp': {
    page: 'tools',
    control: 'list',
    label: s.mcp.title,
    help: s.mcp.subtitle,
    keywords: kw.mcp,
  },
  'tools.library': {
    page: 'tools',
    control: 'list',
    label: s.tools.libraryTitle,
    help: s.tools.librarySubtitle,
  },
  'tools.webSearch': {
    page: 'tools',
    path: [s.tools.webSearch],
    control: 'select',
    label: s.tools.searchProvider,
    help: s.tools.searchProviderHint,
    keywords: kw.webSearch,
    keys: ['search.provider'],
  },

  // Plugins, hooks, schedules
  'plugins.add': {
    page: 'plugins',
    control: 'text',
    label: s.plugins.sourceLabel,
    keywords: [s.plugins.add, ...kw.plugins],
  },
  'hooks.list': {
    page: 'hooks',
    control: 'list',
    label: s.hooks.title,
    help: s.hooks.warning,
    keywords: [...kw.hooks, ...strings(s.hooks.events)],
  },
  'schedules.add': {
    page: 'schedules',
    control: 'form',
    label: s.schedules.newTitle,
    keywords: [...kw.schedules, ...strings(s.schedules.repeat)],
  },
} as const satisfies Record<string, StaticSetting>

export type SettingId = keyof typeof SETTINGS

/** Rows made from live lists, by id: each item is listed by search under its own name. */
export const DYNAMIC = {
  'appearance.theme': dynamic('themes', {
    page: 'appearance',
    path: [ap.gallery],
    control: 'choice',
    item: (x) => ({
      key: x.choice,
      label: x.name,
      path: [ap.gallery, ap.groups[x.group]],
      ...(x.note ? { help: x.note } : {}),
      ...(x.keywords ? { keywords: x.keywords } : {}),
    }),
  }),
  'specialists.specialist': dynamic('specialists', {
    page: 'specialists',
    control: 'list',
    item: (x) => ({ key: x.id, label: x.name, help: x.specialty }),
  }),
  'devices.device': dynamic('devices', {
    page: 'devices',
    control: 'button',
    item: (x) => ({ key: x.id, label: x.name, help: s.devices.scopeNames[x.scope] }),
  }),
  'gateways.gateway': dynamic('gateways', {
    page: 'gateways',
    control: 'button',
    keywords: kw.gateways,
    item: (x) => ({ key: x.id, label: x.name, help: x.url }),
  }),
  'channels.channel': dynamic('channels', {
    page: 'channels',
    control: 'button',
    keywords: kw.channels,
    item: (x) => ({ key: x.id, label: x.label }),
  }),
  'models.provider': dynamic('modelProviders', {
    page: 'models',
    tab: 'models',
    path: [s.page.modelsTab],
    control: 'switch',
    keys: ['models.hiddenProviders'],
    item: (x) => ({ key: x, label: x, help: mo.showProvider(x) }),
  }),
  'models.model': dynamic('models', {
    page: 'models',
    tab: 'models',
    control: 'list',
    keys: ['models.hidden', 'models.windows'],
    item: (x) => ({
      key: x.ref,
      label: x.name,
      help: x.ref,
      keywords: [x.id, 'context window'],
      path: [s.page.modelsTab, x.provider],
    }),
  }),
  'providers.signIn': dynamic('logins', {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, s.signIns.title],
    control: 'button',
    keywords: kw.subscription,
    item: (x) => ({ key: x.id, label: x.name, help: x.provider }),
  }),
  'providers.provider': dynamic('providers', {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, pr.heading],
    control: 'list',
    keywords: kw.apiKey,
    keys: ['models.hiddenProviders'],
    item: (x) => ({ key: x.id, label: x.id, help: pr.modelCount(x.models) }),
  }),
  'voiceProviders.provider': dynamic('voiceProviders', {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, vp.heading],
    control: 'list',
    keywords: kw.apiKey,
    keys: ['voice.regions'],
    item: (x) => ({
      key: x.id,
      label: x.label,
      help: [x.stt && vp.tags.stt, x.tts && vp.tags.tts, x.realtime && vp.tags.realtime]
        .filter(Boolean)
        .join(' · '),
      keywords: [x.id],
    }),
  }),
  'voiceProviders.endpoint': dynamic('voiceEndpoints', {
    page: 'models',
    tab: 'providers',
    path: [s.page.providersTab, vp.endpoints.heading],
    control: 'button',
    item: (x) => ({ key: x.id, label: x.id, help: x.baseUrl }),
  }),
  'permissions.accessGroup': dynamic('accessGroups', {
    page: 'permissions',
    path: [pm.access.title],
    control: 'switch',
    item: (x) => ({ key: x.group, label: x.label, help: x.hint }),
  }),
  'permissions.rule': dynamic('rules', {
    page: 'permissions',
    path: [pm.rules.title],
    control: 'choice',
    item: (x) => ({
      key: `${x.kind}:${x.target}:${x.who ?? 'all'}`,
      label: shownTarget(x),
      help: `${pm.rules.kindOne[x.kind]} · ${pm.rules.decisions[x.decision]}`,
    }),
  }),
  'tools.mcpServer': dynamic('mcpServers', {
    page: 'tools',
    path: [s.mcp.title],
    control: 'switch',
    keywords: kw.mcp,
    item: (x) => ({ key: x.name, label: x.name, help: `${x.transport} · ${x.target}` }),
  }),
  'plugins.plugin': dynamic('plugins', {
    page: 'plugins',
    control: 'switch',
    keywords: kw.plugins,
    item: (x) => ({
      key: x.name,
      label: x.name,
      ...(x.description ? { help: x.description } : {}),
      ...(x.author ? { keywords: [x.author] } : {}),
    }),
  }),
  'skills.skill': dynamic('skills', {
    page: 'skills',
    control: 'switch',
    keywords: kw.skills,
    item: (x) => ({ key: x.name, label: x.name, help: x.description }),
  }),
  'schedules.schedule': dynamic('schedules', {
    page: 'schedules',
    control: 'switch',
    keywords: kw.schedules,
    item: (x) => ({ key: x.id, label: x.request, help: describeCron(x.cron) }),
  }),
} as const

export type DynamicId = keyof typeof DYNAMIC
export type ItemOf<I extends DynamicId> = Parameters<(typeof DYNAMIC)[I]['item']>[0]

/** A dynamic row's key on the page, from the same function search lists the item with. */
export const itemKey = <I extends DynamicId>(id: I, item: ItemOf<I>): string =>
  (DYNAMIC[id].item as (x: ItemOf<I>) => DynamicItem)(item).key

/**
 * Keys of the settings file that no row shows, each with why. The settings registry test fails on a key that is
 * neither here nor claimed by an entry's `keys`, so a new setting cannot be added to the file and forgotten in the UI.
 */
export const NOT_SHOWN: Readonly<Record<string, string>> = {
  version: "The file format's version: Myrmidon sets it, nobody chooses it.",
  setup: "The setup assistant's own progress; General → Run setup again starts it over.",
}
