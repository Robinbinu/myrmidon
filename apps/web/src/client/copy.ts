import type { EventPayloads } from '@myrmidon/protocol'

/**
 * Every word the web client shows, grouped by screen and component. Text with values in it is a function of
 * those values; the components keep the layout and logic.
 *
 * Glossary: one word per concept wherever the person reads it. The code keeps older names (colony, round, team,
 * judge, verifier, verdict, observer, steer, queue, newTask); those stay identifiers and never reach the screen.
 *   chat        one conversation with the lead, listed in the sidebar. Not "task" or "conversation"; a task is only
 *               a card on the task board.
 *   crew        everyone working on a chat: the lead and its crewmates. Not "colony" or "team". Each chat's crew and
 *               its history is listed under Crews, and Compare puts two crews side by side.
 *   lead        the agent you talk to; it plans, asks crewmates for work, and brings more in.
 *   crewmate    an agent working with the lead. Not "helper", "worker", "teammate" or "peer". In Swarm mode there is
 *               no lead and the crewmates are equals sharing one plan. The agents' prompts use the same word.
 *   specialist  a crewmate you defined once in Settings and bring back by name.
 *   run         one message that starts work, and the work it causes. Not "round".
 *   turn        one step of one agent: a model call and the tools it used.
 *   review      the independent check of the work, by the reviewer. Not judge, verdict, verifier, verification.
 *   check-in    Myrmidon's regular look for stuck or idle agents and limits running out. Not "observer".
 *   call assistant  the fast model the person talks to on a voice call; its model is the "call assistant model".
 *   Myrmidon    the running app; "this Myrmidon" in body text, not "server". "Gateway" only where one window switches
 *               between Myrmidons (Settings → Gateways, the switcher). The hardware is "this computer" or "This Mac",
 *               not "machine".
 *   channel     a messaging service the crew answers on (Telegram, Slack…). "App" means Myrmidon itself.
 *   folder      never "directory". An agent's own folder is its "private working folder", not "scratch".
 *   Allow / Deny        a step an agent wants to take. Approve / Decline: people, groups and plans.
 *   Changes asked       the reviewer sent work back. Not "rejections".
 *   Try again   the button after a failure. Not "Retry".
 *   Delete      things you made (chat, schedule, hook, specialist). Remove: connections (project, plugin, provider,
 *               channel, gateway, tool library). Revoke: access (devices, people). Discard: proposals. An armed
 *               confirm button starts with "Yes," and repeats the verb and its object ("Yes, remove channel").
 *   Send now / Send when done   how a message typed during a run reaches the crew (the /steer and /queue commands).
 */
export const copy = {
  brand: {
    name: 'Myrmidon',
  },

  /** Words shared by small controls across the app. */
  common: {
    close: 'Close',
    dismiss: 'Dismiss',
  },

  /** Relative times like "3m ago". */
  time: {
    justNow: 'just now',
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`,
  },

  /** One name per state, shared by every badge, dot label and sheet; ui/status.ts decides which applies. */
  status: {
    agent: {
      provisioning: 'Starting up',
      ready: 'Ready',
      working: 'Working',
      idle: 'Waiting for work',
      done: 'Done',
      resting: 'Resting',
      stopped: 'Stopped',
      failed: 'Failed',
    },
    /** Read after a chat's title by screen readers, which cannot see its status dot. */
    spoken: (label: string) => `, ${label}`,
    /** A chat or run, beside its title. */
    run: {
      working: 'working',
      awaiting: 'waiting for you',
      completed: 'completed',
      stopped: 'stopped',
      failed: 'failed',
      /** Finished while the person was in another chat, and not opened since. */
      unread: 'finished, not seen yet',
    },
  },

  /** Shown for a cost when the model has no price, rather than a made-up $0. */
  unknownCost: 'n/a',

  auth: {
    notAuthorized:
      "This page isn't signed in to Myrmidon. Open the full address Myrmidon printed when it started: it carries the key.",
    pairAgain: 'This device is no longer paired. Pair it again to carry on.',
  },

  /** Why a request to the server failed, when the server did not say. */
  api: {
    unreachable: "Can't reach Myrmidon right now.",
    interrupted: 'The connection dropped before Myrmidon answered. Try again.',
    status: (status: number) =>
      status === 403
        ? "This device isn't allowed to do that."
        : status === 404
          ? "That isn't there any more."
          : status === 413
            ? 'That is too large to send.'
            : status >= 500
              ? copy.api.serverProblem
              : "That didn't work. Try again; if it keeps failing, reload the page.",
    serverProblem: 'Myrmidon hit a problem. Try again; if it keeps happening, restart Myrmidon.',
    badRequest: "Myrmidon couldn't read that request. Reload and try again.",
    chatGone: 'That chat no longer exists.',
    /** `feature` is the server's own lower-case name for it: skills, memory, MCP, the tool library. */
    noChats: (feature: string) => `This Myrmidon was started without chats, so ${feature} can't be used.`,
  },

  /** Pairing a device with a remote gateway. */
  /** Switching between this machine and other gateways. */
  gateways: {
    local: (mac: boolean) => (mac ? 'This Mac' : 'This computer'),
    switcher: 'Gateway shown in this window',
    manage: 'Manage gateways…',
    unreachable: 'Not reachable',
    pluginElsewhere: "A plugin's screen from another gateway opens on that gateway's own address.",
    down: {
      title: (name: string) => `Can't reach ${name}`,
      checking: (name: string) => `Connecting to ${name}…`,
      back: (local: string) => `Use ${local}`,
      retry: 'Try again',
    },
  },

  /** The sidebar chip that appears only when this gateway (or one of its channels) is in trouble. */
  gatewayStatus: {
    offline: 'Offline',
    retry: 'Try again',
    offlineHint: "Myrmidon isn't answering. Check that it is still running; Try again checks now.",
    noModels: 'No model can answer',
    channelDown: (label: string) => `${label} down`,
    more: (n: number) => `+${n} more`,
    open: 'Open System',
  },

  /** System: how this gateway is doing, after Hermes's inspector and OpenClaw's Control UI. */
  system: {
    title: 'System',
    nav: 'System',
    ok: 'Everything is working',
    degraded: 'Something needs attention',
    offline: "Myrmidon isn't answering",
    loading: 'Checking how Myrmidon is doing…',
    problems: {
      noModels: 'No model can answer: add a key or sign in under Settings → Models.',
      channel: (label: string) => `${label} can't connect right now. See Channels below.`,
    },
    gateway: 'This Myrmidon',
    local: 'This computer only',
    remote: (url?: string) =>
      url ? `Reachable from other devices at ${url}` : 'Reachable from other devices',
    up: (since: string) => `Up since ${since}`,
    ping: (ms: number) => `Answers in ${ms} ms`,
    home: 'Data folder',
    models: (n: number) => (n === 1 ? '1 model can answer' : `${n} models can answer`),
    sandbox: (kind?: string) =>
      kind === 'sandbox-exec'
        ? 'Shell commands are confined by macOS'
        : kind === 'bubblewrap'
          ? 'Shell commands are confined by bubblewrap'
          : "Shell commands aren't confined",
    fullAccess: 'Sandbox off: your chats have full access',
    copyPath: 'Copy',
    copied: 'Copied',
    /** The desktop app only: shows the data folder in Finder. */
    reveal: 'Show in Finder',
    running: 'Running now',
    nothingRunning: 'Nothing is running.',
    channels: 'Channels',
    noChannels: 'No channels set up. Add one in Settings → Channels.',
    activity: 'Recent activity',
    noActivity: 'Nothing yet. Messages and answers on your channels show here.',
    /** A channel's connection in plain words; the server's own reason sits behind Show details. */
    channelState: {
      on: 'Connected',
      retrying: 'Reconnecting…',
      error: "Can't connect",
    },
    showDetails: 'Show details',
    restart: 'Restart',
    restarting: 'Restarting…',
    restarted: (label: string) => `${label} restarted.`,
    restartFailed: (label: string, reason: string) => `${label} couldn't restart: ${reason}`,
    leftOff: (label: string, reason: string) =>
      `${label} is off now; it couldn't be turned back on: ${reason}`,
    turnOn: 'Turn on',
    turnedOn: (label: string) => `${label} is on again.`,
    manage: 'Manage',
    refresh: 'Refresh',
    tryAgain: 'Try again',
  },

  /** A new request to talk to the crew through a channel, as a toast and a desktop notification. */
  /** Files on messages: before sending and once sent. */
  attachments: {
    kinds: {
      image: 'Image',
      pdf: 'PDF',
      audio: 'Audio',
      video: 'Video',
      archive: 'Archive',
      sheet: 'Spreadsheet',
      code: 'Code',
      text: 'Document',
      file: 'File',
    },
    open: (name: string) => `Open ${name}`,
    view: (name: string) => `View ${name} full size`,
    notPicture: 'That file is not a picture.',
  },

  call: {
    start: 'Call',
    startTitle: 'Talk with your crew by voice',
    hangUp: 'Hang up',
    mute: 'Mute',
    unmute: 'Unmute',
    states: {
      connecting: 'Connecting…',
      preparing: 'Getting ready…',
      listening: 'Listening',
      hearing: 'Hearing you…',
      thinking: 'Thinking…',
      speaking: 'Speaking',
      muted: 'Muted',
      ended: 'Call ended',
    },
    you: 'You',
    /** Who said a line of the call. */
    speaker: { assistant: 'Assistant', lead: 'Lead' },
    menu: {
      assistant: 'Call assistant',
      assistantHint: 'A fast model: answers quick things, hands work to the crew, asks them for you',
      lead: 'The lead',
      leadHint: 'Talk to the lead directly; its replies are read aloud',
      agentHint: (role?: string) =>
        `${role ? `${role} · ` : ''}talk to them directly; they get the chat so far`,
    },
    /** In the call bar: who the call is with, and the chat it is in. */
    with: (who: string) => `With ${who}`,
    inChat: (title: string) => `In ${title}`,
    openChat: (title: string) => `Go to the chat “${title}”`,
    /** Before what waits for the person's answer, said aloud on the call. */
    approval: 'Waiting for your yes or no:',
    /** How long the last answer took to start, after the person stopped talking. */
    latency: (ms: number) => `answered in ${(ms / 1000).toFixed(1)} s`,
    assistantName: 'the call assistant',
    leadName: 'the lead',
    started: (request: string) => `Crew started: ${request}`,
    noMic: 'Myrmidon could not use the microphone. Allow it for this page and try again.',
    insecure:
      'Calls need the microphone, which browsers allow only over https or on the computer Myrmidon runs on. Open Myrmidon there, or over https.',
    couldNotStart:
      'Couldn’t start the call. Check that Myrmidon is running and voice calls are on in Settings → Voice.',
    dropped: 'The call dropped: Myrmidon stopped answering. Check that it is still running, then call again.',
    failed:
      'The call stopped because of a problem in Myrmidon. Call again; if it keeps happening, check its log.',
    openVoiceSettings: 'Open Settings → Voice',
    card: {
      title: (minutes: number) => `Call · ${minutes < 1 ? 'under a minute' : `${minutes} min`}`,
      /** A call on the phone line, with the number on the other end. */
      phone: (minutes: number, number: string) =>
        `Phone call with ${number} · ${minutes < 1 ? 'under a minute' : `${minutes} min`}`,
      show: 'Show transcript',
      hide: 'Hide transcript',
      crew: 'Crew update',
    },
  },

  channelRequest: {
    person: (name: string, label: string) => `${name} wants to talk to your crew on ${label}`,
    group: (name: string, label: string) => `The ${label} group “${name}” wants your crew`,
    review: 'Review',
  },

  pairing: {
    title: 'Pair this device',
    introBefore:
      'This Myrmidon runs on another computer. To use it from here, pair this device once: on that computer run ',
    introAfter:
      ', or make a link in Settings → Devices on a device that is already paired, then open the link or enter its code.',
    code: 'Pairing code',
    codeHint: 'Ten letters and digits, valid for 10 minutes, usable once.',
    name: 'Name for this device',
    nameHint: 'How it shows in Settings → Devices, where you can revoke it.',
    pair: 'Pair',
  },

  agentChip: {
    label: (name: string) => `What ${name} is doing`,
  },

  /** The mascot's status line, one word or two per emotion. */
  mascot: {
    ready: 'ready',
    listening: 'listening',
    curious: 'curious',
    focused: 'focused',
    concerned: 'on it',
    love: 'glad to help',
    happy: 'all good',
    proud: 'done',
    wink: 'hello',
    surprised: 'oh',
    dizzy: 'a bit dizzy',
    confused: 'so confused',
    sneeze: 'achoo',
    charging: 'charging',
    popped: 'pop!',
    onCall: 'on a call',
    sad: 'oh no',
    sleepy: 'zzz',
    night: 'late night',
    busy: 'working',
    crewsWorking: (n: number) => (n === 1 ? '1 crew working' : `${n} crews working`),
  },

  modelPicker: {
    windowUnknown: 'Context window unknown',
    windowSize: (tokens: string) => `${tokens} tokens of context`,
    windowGuess: (size: string) => `${size}, a guess: set the real size in Settings → Models`,
    windowTooSmall: (size: string) => `${size}: too small for agent work, fine for short chats`,
    buttonLabel: (label: string) => `${label} model`,
    choose: 'Choose a model',
    search: (count: number) => `Search ${count} models…`,
    searchLabel: (label: string) => `Search ${label} models`,
    noMatch: (query: string) => `No models match “${query}”.`,
    tooSmall: 'Too small for agent work',
    thinking: 'Supports extended thinking',
    custom: 'custom',
    key: 'key',
  },

  composer: {
    modes: {
      orchestrated: {
        name: 'Orchestrated',
        hint: 'A lead assigns tasks to crewmates, each on the model that fits',
      },
      swarm: {
        name: 'Swarm',
        hint: 'Equal crewmates share one plan, notes, and tasks; no boss',
      },
    },
    teamLabel: (swarm: boolean, n: number) =>
      `${swarm ? 'Swarm' : 'Orchestrated'} · ${n} crewmate${n === 1 ? '' : 's'}`,
    thinking: { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' },
    review: { off: 'Off', auto: 'Auto', always: 'Always' },
    lead: 'Lead',
    leadHint: 'Who you talk to',
    reviewer: 'Reviewer',
    reviewerHint: {
      off: 'Answers are not reviewed',
      always: 'Checks every final answer',
      auto: 'When the lead asks for a check',
      unknown: 'Checks the work',
    },
    thinkingLabel: 'Thinking',
    thinkingHint: 'Auto: quick for questions, deeper for work',
    sameProvider:
      'The reviewer shares a provider with the crew; one from another provider catches more of its blind spots.',
    helpers: 'Crewmates',
    /** The fold under the crewmates setting that lists each crewmate and its model. */
    helperList: 'Who is on the crew',
    deliveries: {
      steer: { label: 'Send now', hint: 'Read at the crew’s next step' },
      queue: { label: 'Send when done', hint: 'Read once the current work is done' },
    },
    attachedOnly: 'See the attached files.',
    reasoning: ' · reasoning',
    /** Writing to a crewmate directly by typing @ and their name. */
    mention: {
      section: 'Write directly to',
      label: 'Crewmates to write to',
    },
    teamDialog: 'Crew and models',
    teamHeading: 'Lead & crewmates',
    teamApplies: 'Applies to your next messages',
    removeFile: (name: string) => `Remove ${name}`,
    /** Several attachments refused at once; one file uses copy.app.fileTooLarge, which names the same size. */
    filesTooLarge: (names: readonly string[]) =>
      `${names.length} files are larger than 10 MB: ${names.join(', ')}`,
    tooManyFiles: (max: number, left: number) =>
      `A message can carry ${max} files; ${left} ${left === 1 ? 'was' : 'were'} not attached`,
    exported: 'Chat downloaded as Markdown; look in your downloads folder',
    message: 'Message',
    attach: 'Attach files',
    attachTitle: 'Attach files (or drop / paste them)',
    deliveryTitle: (hint?: string) => `${hint}. Click to switch (Alt+Enter sends the other way).`,
    deliveryLabel: (delivery: string, other: string) => `Delivery: ${delivery}. Switch to ${other}`,
    stopLabel: 'Stop the crew',
    stopTitle: (status: string) => `${status} Click to stop.`,
    stop: 'Stop',
    send: 'Send',
    sendTitle: 'Send (Enter)',
  },

  /** The activity feed's rows: a lead phrase, sometimes a bold subject, sometimes a quieter tail. */
  steps: {
    thought: 'Thought',
    searched: 'Searched the web for',
    read: 'Read',
    ran: 'Ran',
    edited: 'Edited',
    wrote: 'Wrote',
    toolFailed: (tool: string) => `${tool} failed:`,
    created: 'Created',
    updated: 'Updated',
    planned: 'Planned',
    taskDone: 'Task done:',
    sentBack: (task: string) => `Sent ${task} back:`,
    needsRework: 'Task needs rework:',
    broughtIn: 'Brought in',
    promptInjection: 'Ran a command copied from web content:',
    injectionSource: (reason: string, source: string) => `${reason} (from ${source})`,
    startedServer: (name: string) => `Started ${name} at`,
    stoppedServer: (name: string) => `Stopped ${name}`,
    handedTo: (team: boolean) => `Handed the request to ${team ? 'a crew' : 'one agent with every tool'}:`,
    hookBlocked: (tool?: string) => `A hook blocked ${tool ?? 'a call'}:`,
    hookAsked: (tool?: string) => `A hook asked you about ${tool ?? 'a call'}:`,
    hookFlagged: (tool?: string) => `A hook flagged ${tool ?? 'the result'}:`,
    /** `event` is the runtime's hook event id, named here as Settings → Hooks names it. */
    hookFailed: (event: string, code?: number) =>
      `Your “${(copy.settings.hooks.events as Record<string, string>)[event] ?? event}” hook failed (exit code ${code}):`,
    readSkillFile: (file: string) => `Read ${file} from skill`,
    usedSkill: 'Used skill',
    proposedMemory: 'Proposed to remember:',
    ownBranch: 'Works on its own branch',
    merged: (n: number) => `Merged ${n} file${n === 1 ? '' : 's'} into the project`,
    onMac: (app: string) => `On your Mac, in ${app}:`,
    computerSetup: 'Computer use needs setting up:',
    broughtChanges: (n: number) =>
      `Brought ${n} changed file${n === 1 ? '' : 's'} from the project into its branch`,
    mergeConflict: 'Merge conflict, sent back to resolve:',
    keptBranch: 'Kept its branch: it holds changes that were not merged',
    askedApproval: 'Asked you to allow',
    approved: 'Allowed',
    notApprovedInTime: 'Not answered in time',
    denied: 'Denied',
    compacted: 'Summarized older messages to make room',
    compactedTail: (messages: number, kTokens: number) => `${messages} messages, at ~${kTokens}k tokens`,
    switchedTo: 'Switched to',
    switchedFrom: (model?: string) => `from ${model}, by you`,
    askedJudge: 'Asked the reviewer to check the result',
    judgeApproved: 'Reviewer approved',
    judgeRejected: 'Reviewer asked for changes',
    score: (score: string) => `score ${score}`,
    messaged: (to: string) => `Messaged ${to}:`,
    posted: 'Posted:',
    observer: (kind: string) => `Check-in (${kind}):`,
    /** The "now doing" line during a run. */
    now: {
      doing: (agent: string, what: string) => `${agent} is ${what}`,
      thinking: (agent: string) => `${agent} is thinking`,
      searching: (query: string) => `searching "${query}"`,
      reading: (where: string) => `reading ${where}`,
      writing: (name: unknown) => `writing ${String(name ?? 'a file')}`,
      drafting: (path: unknown) => `drafting ${String(path ?? 'a file')}`,
      editing: (path: unknown) => `editing ${String(path ?? 'a file')}`,
      runningCommand: 'running a command',
      waitingForJudge: 'waiting for the reviewer',
      bringingIn: (name: unknown) => `bringing in ${String(name ?? 'a crewmate')}`,
      askingCrewmate: (name: unknown) => `asking ${String(name ?? 'a crewmate')}`,
      planningTasks: 'planning tasks',
      writingReply: 'writing a reply',
      usingMac: 'using your Mac',
      using: (tool: string) => `using ${tool}`,
    },
  },

  /** One-line summaries of raw events, for the timeline and the event feed. */
  events: {
    colonyCreated: (name: string) => `crew created: ${name}`,
    crewStarted: 'crew started',
    colonyStopped: (reason: string) => `crew stopped: ${reason}`,
    /** Whether it was reviewed is the review line's to say: a run can finish unreviewed. */
    crewCompleted: 'crew completed',
    notReviewed: 'final answer delivered, not reviewed',
    turn: (agent: string, turn: number, phase: string, trigger: string) =>
      `${agent} turn ${turn} ${phase} [${trigger}]`,
    ok: 'ok',
    error: 'error',
    onBoard: (agent: string, text: string) => `${agent} on board: ${text}`,
    noted: (agent: string, text: string) => `${agent} noted: ${text}`,
    mailDelivered: (to: string) => `mail delivered to ${to}`,
    published: (author: string, name: string, version: number) => `${author} published ${name} v${version}`,
    observer: (kind: string, severity: string, facts: string) => `check-in, ${kind} (${severity}): ${facts}`,
    verificationRequested: (by: string) => `${by} asked for a review`,
    verdict: (target: string, pass: boolean) => `review of ${target}: ${pass ? 'passed' : 'failed'}`,
    /** A plain name for every kind of log event, for the replay bar and any line with nothing more specific to say. */
    types: {
      'colony/created': 'crew created',
      'colony/started': 'crew started',
      'colony/stopped': 'crew stopped',
      'round/started': 'run started',
      'memory/proposed': 'memory suggested',
      'memory/decided': 'memory kept or discarded',
      'skill/proposed': 'skill suggested',
      'skill/decided': 'skill kept or discarded',
      'hook/ran': 'hook ran',
      'skill/used': 'skill used',
      'colony/escalated': 'run handed to a bigger crew',
      'agent/joined': 'crewmate joined',
      'browser/keyframe': 'browser step',
      'computer/keyframe': 'step on your Mac',
      'computer/apps': 'apps allowed on your Mac',
      'computer/control': 'controlling your Mac',
      'computer/blocked': 'computer use needs setting up',
      'agent/error': 'model error',
      'agent/dismissed': 'crewmate let go',
      'approval/requested': 'approval asked',
      'login/requested': 'sign-in asked',
      'login/finished': 'sign-in finished',
      'safety/flagged': 'step flagged as unsafe',
      'server/started': 'server started',
      'server/stopped': 'server stopped',
      'worktree/created': 'worktree created',
      'worktree/merged': 'worktree merged',
      'worktree/updated': 'worktree updated',
      'worktree/conflict': 'worktree conflict',
      'worktree/closed': 'worktree closed',
      'approval/decided': 'approval answered',
      'review/done': 'approved step ran',
      'checkpoint/created': 'checkpoint saved',
      'checkpoint/restored': 'files rewound',
      'permissions/changed': 'permissions changed',
      'plugin/event': 'plugin event',
      'agent/compacted': 'older messages summarized',
      'agent/prompt': 'prompt assembled',
      'agent/model': 'model switched',
      'tool/created': 'tool made',
      'chat/user': 'message from you',
      'chat/reply': 'reply',
      'chat/renamed': 'chat renamed',
      'chat/allowed': 'allowed for this chat',
      'chat/permissions': 'chat permissions set',
      'colony/failed': 'crew failed',
      'colony/completed': 'crew completed',
      'agent/status': 'status changed',
      'agent/turn': 'turn',
      'llm/response': 'model reply',
      'tool/call': 'tool call',
      'tool/result': 'tool result',
      'board/posted': 'posted to the board',
      'note/appended': 'note added',
      'mail/sent': 'mail sent',
      'group/created': 'group created',
      'group/changed': 'group changed',
      'mail/delivered': 'mail delivered',
      'task/changed': 'task changed',
      'artifact/versioned': 'file published',
      'observer/signal': 'check-in',
      'verifier/requested': 'review asked',
      'verifier/verdict': 'review',
    } satisfies Record<keyof EventPayloads, string>,
  },

  /** What a check-in noticed, keyed by the runtime's signal kind and severity. */
  checkIn: {
    kinds: {
      deadline: 'time limit',
      budget: 'spend limit',
      stall: 'stalled',
      unclaimed: 'unclaimed task',
      blocked: 'blocked',
      conflict: 'conflict',
    } as Record<string, string>,
    severities: { info: 'note', warn: 'warning', critical: 'critical' } as Record<string, string>,
  },

  /** What a review looked at: the runtime names the final answer `colony` and a task `task:<id>`. */
  reviewTarget: (target: string) =>
    target === 'colony'
      ? 'the final answer'
      : target.startsWith('task:')
        ? `task ${target.slice(5)}`
        : target,

  /** The empty state: the mascot, the headline and the starter prompts. */
  hero: {
    headline: 'What should the crew build?',
    poke: 'Make the mascot react',
    recent: 'Recent chats',
    /** The crew cursors around the mascot are named from this list, a few picked at random each visit. */
    crewNames: [
      'Kevin',
      'Stuart',
      'Bob',
      'Dave',
      'Jerry',
      'Carl',
      'Phil',
      'Tim',
      'Mark',
      'Jorge',
      'Otto',
      'Mel',
      'Norbert',
      'Lance',
      'Donny',
      'Ken',
      'Mike',
      'Tom',
      'Steve',
      'John',
      'Paul',
      'Chris',
    ],
    /** What the mascot's screen spells out in dots (letters, digits and a few signs only). */
    screen: {
      hello: (name: string) => `HI ${name.toUpperCase()}`,
      atWork: (n: number) => `${n} AT WORK`,
    },
    suggestions: {
      research: {
        label: 'Research',
        text: 'Compare the three most popular Rust web frameworks this year and write a report with a source for every claim.',
      },
      app: {
        label: 'Build an app',
        text: 'Build a single-file HTML snake game with keyboard and touch controls, levels, and a saved high score.',
      },
      code: {
        label: 'Tested code',
        text: 'Write a Python CLI that converts CSV files to Parquet, with type hints, error handling, and pytest tests.',
      },
      explain: {
        label: 'Explain',
        text: 'Explain how transformers handle long context today, with a short glossary and further reading.',
      },
    },
  },

  /** The first-run setup assistant: one step per screen, a list of them to jump between, and its mascot. */
  setup: {
    title: 'Set up Myrmidon',
    navLabel: 'Setup steps',
    finishLater: 'Finish later',
    finishLaterTitle: 'Close the assistant. What is left waits on the home screen.',
    /** One step opened on its own, from the home screen or Settings: it goes back there when done. */
    single: { close: 'Close', done: 'Done' },
    back: 'Back',
    continue: 'Continue',
    later: 'Set up later',
    tryAgain: 'Try again',
    loading: 'Loading…',
    /** Read out as each step opens. */
    announce: (n: number, total: number, title: string) => `Step ${n} of ${total}: ${title}`,
    /** After a step's name in the list, for screen readers, which cannot see its dot. */
    status: {
      done: 'done',
      current: 'current step',
      later: 'set up later',
      todo: 'not set up yet',
    },
    steps: {
      welcome: 'Welcome',
      you: 'You & mascot',
      models: 'Connect models',
      crew: 'Your crew',
      project: 'Your first project',
      voice: 'Voice calls',
      channels: 'Messaging apps',
      alerts: 'Alerts',
      ready: 'Ready',
    },
    /** The mascot's status line during setup, beside the moods it has everywhere. */
    mascot: {
      yawn: 'yawn',
      thinking: 'thinking',
      worried: 'hmm',
      shrug: 'maybe later',
      nod: 'nice',
      ping: 'ping',
      celebrate: 'all set',
    },
    /** What its dot screen spells (letters, digits and a few signs only). */
    screen: {
      hi: 'HI',
      hello: (name: string) => `HI ${name.toUpperCase()}`,
      thinking: 'THINKING',
      ping: 'PING',
      percent: (n: number) => `${n}%`,
    },
    welcome: {
      title: 'Welcome to Myrmidon',
      intro:
        'Myrmidon runs a crew of AI agents on this computer. You talk to the lead; it plans the work and asks crewmates to research, build and review it.',
      localTitle: 'What stays on this computer',
      local:
        'Your chats, files, settings and keys stay here. What leaves is what the crew sends to the model providers you connect, and the web pages it reads.',
      theme: 'Theme',
      start: 'Get started',
    },
    you: {
      title: 'You & your mascot',
      intro: 'What the mascot calls you and how it looks. It changes as you pick.',
    },
    models: {
      title: 'Connect a model',
      intro:
        'The crew needs a model to think with. Use one this computer already has, sign in to a provider, or add a key.',
      found: 'Found on this computer',
      looking: 'Looking for models on this computer…',
      none: 'Nothing found yet. Sign in or add a key below.',
      lookFailed: (reason: string) => `Could not look for models: ${reason}`,
      ready: 'Ready',
      models: (n: number) => `${n} model${n === 1 ? '' : 's'}`,
      envKey: (variable: string) => `${variable} is set`,
      envKeyHint: 'A key in Myrmidon’s environment. It stays there; Myrmidon does not copy it.',
      local: { ollama: 'Ollama', 'lm-studio': 'LM Studio' } as Record<string, string>,
      localRunning: (name: string) => `${name} is running`,
      use: 'Use',
      pickLabel: (name: string) => `Use ${name}`,
      inUse: 'In use',
      adding: (name: string) => `Adding ${name}…`,
      noModels: (name: string) => `${name} lists no models that can lead a crew yet.`,
      tooSmall: 'Its models are too small to lead a crew',
      more: 'More ways to connect',
      testTitle: 'Test it',
      testHint: 'Myrmidon sends the model a one-line message and waits for the reply.',
      testModel: 'Model to test',
      test: 'Send a test message',
      testing: 'Waiting for the reply…',
      answered: (seconds: string, reply?: string) =>
        reply ? `It answered in ${seconds} s: “${reply}”` : `It answered in ${seconds} s`,
      failed: 'The model did not answer',
      noModel: 'Connect a model above, then test it here.',
      gate: 'Continue opens once a model answers.',
    },
    crew: {
      title: 'Your crew',
      intro:
        'Every new chat starts with this crew; the message box changes it for one chat. The lead does the talking and asks crewmates for work.',
      waiting: 'The crew can be set once a model is connected.',
    },
    project: {
      title: 'Your first project',
      intro:
        'A project is a folder on this computer the crew works in: it reads the files and, if you let it, changes them.',
      choose: 'Choose a folder',
      change: 'Choose another folder',
      none: 'No folder chosen yet.',
      git: 'A git repository, so it starts on Ask first: each change waits for your yes.',
      notGit: 'Not a git repository, so it starts read-only: agents read it and propose changes.',
      permissions: 'What agents may do here',
      spend: 'Spend limit per run',
      spendHint: 'A run stops once its model calls cost this much. 0 means no limit.',
      reviewer: 'Review the work',
      reviewerHint: 'An independent reviewer checks the crew’s answers before they reach you.',
      saveFailed: (reason: string) => `Could not save the folder’s permissions: ${reason}`,
    },
    voice: {
      title: 'Voice calls',
      intro: 'Talk to the crew out loud. Nothing is downloaded until you choose.',
      choice: 'Voice calls',
      off: 'Off',
      local: 'On this computer',
      cloud: 'Cloud',
      offHint: 'You can turn calls on later in Settings → Voice.',
      localHint: (size: string) =>
        size
          ? `Speech is heard and spoken on this computer. About ${size} downloads once, in the background.`
          : 'Speech is heard and spoken on this computer. The engines download once, in the background.',
      cloudHint: (models: string) =>
        models
          ? `Speech goes to your providers’ speech models (${models}).`
          : 'Speech goes to your providers’ speech models. None you connected has one yet; an OpenAI or Groq key does.',
      installing: 'Getting the speech engines ready',
      progress: (pct: number) => `${pct}% downloaded`,
      ready: 'Speech engines ready',
      failed: 'A speech engine could not be set up',
      micTitle: 'Microphone',
      micWhy: 'Calls need your microphone; Myrmidon asks for it once, here.',
      micAllow: 'Allow the microphone',
      micListening: 'Say something: the mascot hears you.',
      micStop: 'Stop the test',
      micLevel: 'Microphone level',
      micDenied: {
        browser:
          'The microphone was not allowed. To allow it later, open the site settings from your browser’s address bar, then call from any chat.',
        desktop:
          'The microphone was not allowed. To allow it later, open System Settings → Privacy & Security → Microphone and turn on Myrmidon.',
      },
      micUnavailable: 'This page cannot use a microphone. Open Myrmidon at localhost or over https.',
    },
    channels: {
      title: 'Messaging apps',
      intro:
        'Talk to the crew from the apps you already use. Pick one to connect it; come back for more any time.',
      connected: (name: string) => `${name} is connected`,
    },
    alerts: {
      title: 'Alerts',
      intro: 'Know when a chat finishes or needs you while Myrmidon is in the background.',
      notify: 'Notify me when a chat finishes or needs me',
      notifyHint: 'A notification on this device, only while Myrmidon is not in front.',
      test: 'Send a test notification',
      testBody: 'This is how Myrmidon tells you a chat is done.',
      /** How the test went, under its button. */
      result: {
        sent: 'Sent. Look for it in the corner of your screen. Nothing there? Check that Focus or Do Not Disturb is off and that your system lets this browser notify.',
        sentDesktop:
          'Sent. Look for it in the corner of your screen. Nothing there? Check that Focus is off and that System Settings → Notifications → Myrmidon allows them.',
        waiting:
          'Switch to another app to see it: macOS shows Myrmidon’s notifications while it is in the background, so the test arrives as you leave.',
        blocked:
          'Blocked: this browser does not let Myrmidon notify. Allow notifications in the site settings from the address bar, then try again.',
        failed: (error: string) => `The notification could not be sent: ${error}`,
      },
      badge: 'Count on the Dock icon',
      badgeHint: 'The number of chats waiting for you.',
      unsupported: 'This browser cannot show notifications.',
      denied: {
        browser:
          'Notifications were not allowed. To allow them later, open the site settings from your browser’s address bar, then Settings → General.',
        desktop:
          'Notifications were not allowed. To allow them later, open System Settings → Notifications → Myrmidon.',
      },
    },
    ready: {
      title: 'You’re ready',
      intro: 'Here is what you set up. Anything left waits on the home screen.',
      done: 'Set up',
      later: 'Set up later',
      todo: 'Not set up',
      open: (step: string) => `Open ${step}`,
      starters: 'Start your first chat',
      noModel: 'The crew needs a model before it can start a chat.',
      connect: 'Connect a model',
      finish: 'Open Myrmidon',
      starter: {
        project: (name: string) => ({
          label: `Summarise ${name}`,
          text: 'Summarise this project: what it is, how it is laid out, and where to start reading.',
        }),
        projectRisks: {
          label: 'Find what to fix first',
          text: 'Look through this project and list the five things most worth fixing or improving, with the files for each.',
        },
        research: {
          label: 'Research a question',
          text: 'Compare the three most popular note-taking apps this year and write a short report with a source for every claim.',
        },
        app: {
          label: 'Build a small app',
          text: 'Build a single-file HTML snake game with keyboard and touch controls, levels, and a saved high score.',
        },
        explain: {
          label: 'Explain something',
          text: 'Explain how large language models handle long context today, with a short glossary and further reading.',
        },
      },
    },
    /** On the home screen once setup is finished, while steps set up later are left. */
    nudge: {
      title: (n: number) => `Finish setting up · ${n} left`,
      body: (steps: string) => `Still to do: ${steps}.`,
      action: 'Continue',
      dismiss: 'Not now',
      dismissTitle: 'Hide this for good. Every step stays in Settings → General.',
      dismissed: 'Hidden for good. You can run any step from Settings → General.',
    },
  },

  teamControls: {
    effort: {
      auto: { title: 'Auto', hint: 'Quick for questions, deeper for real work' },
      low: { title: 'Fast', hint: 'Answers right away' },
      medium: { title: 'Balanced', hint: 'Thinks before it acts' },
      high: { title: 'Deep', hint: 'Thinks hard at every step; slower' },
    },
    thinking: { label: 'Thinking' },
    review: {
      off: { title: 'Off', hint: 'The lead’s answer completes the run' },
      auto: { title: 'Auto', hint: 'The lead asks for a check when the work deserves it' },
      always: { title: 'Always', hint: 'Every final answer is checked before it is done' },
    },
    reviewer: {
      label: 'Reviewer',
      valueOff: 'No review',
      valueAlways: 'Always review',
      valueAuto: 'Review',
      model: 'Reviewer model',
    },
    /** The one chip thinking, reviewer and crewmates fold into when the toolbar is narrow. */
    team: {
      label: 'Crew',
      summary: (thinking: string, reviewer: string, helpers: string) =>
        `Crew: thinking ${thinking.toLowerCase()} · ${reviewer.toLowerCase()} · ${helpers.toLowerCase()}`,
    },
    /** One set of words for the crewmates setting, used on the chip and in every summary of it. */
    helpers: {
      label: 'Crewmates',
      none: 'No crewmates',
      summary: (n: number, swarm: boolean, mode: string) =>
        `${n} crewmate${n === 1 ? '' : 's'} · ${mode.toLowerCase()}`,
    },
    helperModes: {
      never: { title: 'Never', hint: 'The lead works alone, like a chat' },
      auto: { title: 'Auto', hint: 'The lead brings crewmates in when a job needs them' },
      always: { title: 'Always', hint: 'Every message starts with the whole crew' },
    },
    stepper: {
      fewer: (label: string) => `Fewer ${label}`,
      more: (label: string) => `More ${label}`,
    },
    editor: {
      style: 'Style',
      orchestrated: 'Lead + crewmates',
      swarm: 'Equal crewmates',
      peer: (n: number) => `Crewmate ${n}`,
      peerLower: (n: number) => `crewmate ${n}`,
      roleOf: (n: number) => `Role of crewmate ${n}`,
      helper: 'Crewmate',
      minReason: (window: string) => `Under ${window}: too small for a crewmate's tools`,
      remove: (who: string) => `Remove ${who}`,
      addPeer: 'Add crewmate',
      addHelperLabel: 'Add a crewmate',
      addHelper: 'Add crewmate…',
      custom: 'Custom',
      /** The saved specialists in the add-crewmate list. */
      yourSpecialists: 'Your specialists',
      specialistOf: (name: string, specialty: string) => `${name} · ${specialty}`,
      moreOnDemand: {
        label: 'More on demand',
        hint: 'Extra crewmates the lead may add when the job needs them',
        stepper: 'extra crewmates',
      },
    },
  },

  commands: {
    /** Section headings in the slash menu, keyed by command group id. */
    groups: { Round: 'Run', 'Team & model': 'Crew & model', Chat: 'Chat', App: 'App', Plugins: 'Plugins' },
    fromPlugin: (plugin: string) => `From the ${plugin} plugin`,
    list: {
      plan: { args: '<request>', description: 'Plan first: see the plan and approve it before any work' },
      steer: { args: '<message>', description: 'Send now: the crew reads it at its next step' },
      queue: {
        args: '<message>',
        description: 'Send when done: the crew reads it once its current work is finished',
      },
      stop: { description: 'Stop the run' },
      resume: { description: 'Pick a stopped run back up where it left off' },
      retry: { description: 'Run the last request again' },
      model: { args: '<name>', description: 'Switch the lead model, right away if a run is going' },
      mode: {
        description: 'A lead with crewmates, or crewmates as equals',
        options: {
          orchestrated: {
            label: 'Orchestrated',
            description: 'A lead plans and assigns work to crewmates',
          },
          swarm: { label: 'Swarm', description: 'Equal crewmates agree a plan and claim the work' },
        },
      },
      thinking: {
        description: 'How hard reasoning models think while they work',
        options: {
          auto: {
            label: 'Auto',
            description: 'Each role decides: leads think hard, quick answers think less',
          },
          low: { label: 'Low', description: 'Fastest and cheapest' },
          medium: { label: 'Medium', description: 'Balanced' },
          high: { label: 'High', description: 'Most careful; slower' },
        },
      },
      team: { description: 'Open the crew and model picker' },
      new: { description: 'Start a new chat' },
      rename: { args: '<title>', description: 'Rename this chat' },
      attach: { description: 'Attach files to your next message' },
      export: { description: 'Download this chat as Markdown' },
      learn: { description: 'Learn a skill from how this chat did its work' },
      mcp: { description: 'Manage MCP servers (tool connectors)' },
      settings: { description: 'Open settings' },
      help: { description: 'Show every command' },
    },
    /** Why a command is dimmed in the menu. */
    unavailable: {
      notRunning: 'Nothing is running',
      noChat: 'Open a chat first',
      waitForRound: 'Wait for the run to finish',
      nothingToResume: 'No stopped run to resume',
    },
  },

  commandMenu: {
    label: 'Commands',
    recent: 'Recent',
    /** The last section of the slash menu: commands that can't run in this chat right now. */
    unavailable: 'Not available now',
    help: {
      title: 'Every command, and the keys the composer knows',
      keysSection: 'Keys',
      keys: [
        { keys: ['Enter'], does: 'Send, or run the highlighted command' },
        { keys: ['Shift', 'Enter'], does: 'New line' },
        { keys: ['Alt', 'Enter'], does: 'During a run, send the other way (now or when done)' },
        { keys: ['/'], does: 'Commands, typed at the start of a message' },
        { keys: ['@'], does: 'Write directly to a crewmate by name' },
        { keys: ['Tab'], does: 'Complete the highlighted command, or take the next word of a suggestion' },
        { keys: ['→'], does: 'Take the whole suggestion (grey text after the cursor)' },
        { keys: ['Esc'], does: 'Close this menu and keep what you typed' },
      ],
    },
    chooseFor: (args: string, name: string) => `Choose ${args} for /${name}`,
    anArgument: 'an argument',
    noMatches: 'No matches. Esc to close.',
    /** The single row shown while typing an argument that has no fixed choices. */
    argHint: {
      run: (name: string) => `Run /${name}`,
      type: (args: string) => `Type ${args}`,
      theArgument: 'the argument',
      typeFirst: 'Type first',
    },
    footer: { move: 'move', choose: 'choose', run: 'run', complete: 'complete', close: 'close' },
  },

  /** The ⌘K menu: one field to reach any chat, project, Settings page or app action. */
  palette: {
    label: 'Command menu',
    placeholder: 'Search chats, projects, settings and actions',
    results: 'Results',
    groups: { actions: 'Actions', chats: 'Chats', projects: 'Projects', settings: 'Settings' },
    actions: {
      newChat: 'New chat',
      toggleSidebar: 'Show or hide the sidebar',
      toggleWorkspace: 'Show or hide the workspace',
      settings: 'Open Settings',
      shortcuts: 'Keyboard shortcuts',
      export: 'Export this chat as Markdown',
      crewConsole: 'Open the crew console',
    },
    newChatIn: (name: string) => `New chat in ${name}`,
    noMatches: (query: string) => `Nothing matches “${query}”.`,
    footer: { move: 'move', open: 'open', close: 'close' },
  },

  /** Right-click menus: on a chat, a project, a message, a file, a command or an address. */
  contextMenu: {
    chat: {
      label: (title: string) => `Chat “${title}”`,
      rename: 'Rename',
      export: 'Export as Markdown',
      copyLink: 'Copy link',
      linkCopied: 'Link copied',
      delete: 'Delete chat',
    },
    project: {
      label: (name: string) => `Project ${name}`,
      newChat: 'New chat here',
      permissions: 'Permissions',
      copyPath: 'Copy folder path',
      pathCopied: 'Folder path copied',
    },
    message: {
      label: 'Message',
      copy: 'Copy',
      copyMarkdown: 'Copy as Markdown',
    },
    link: {
      label: (url: string) => `Link ${url}`,
      open: 'Open link',
      copy: 'Copy link',
    },
    file: {
      label: (name: string) => `File ${name}`,
      open: 'Open',
      copyName: 'Copy name',
    },
    copy: 'Copy',
    copied: 'Copied',
  },

  sidebar: {
    label: 'Chats',
    hide: 'Hide sidebar',
    newTask: 'New chat',
    withShortcut: (action: string, combo: string) => `${action} (${combo})`,
    search: { placeholder: 'Search', label: 'Search chats' },
    /** Date headings for chats outside a project. */
    groups: {
      /** Above everything else: chats waiting on the person's answer or approval. */
      needsYou: 'Needs you',
      today: 'Today',
      yesterday: 'Yesterday',
      previous7Days: 'Previous 7 days',
      older: 'Older',
    },
    chat: {
      titleField: 'Chat title',
      rename: 'Rename chat',
      renameLabel: (title: string) => `Rename “${title}”`,
      delete: 'Delete chat',
      deleteLabel: (title: string) => `Delete “${title}”`,
      /** The number beside a chat: each message that started work in it is a run. */
      rounds: (n: number) => `${n} runs: messages that started work in this chat`,
      /** Before a line of a message that matched the search; `from` is the agent's name or `user`. */
      matchFrom: (from: string) => (from === 'user' ? 'You: ' : `${from}: `),
    },
    /** Several chats picked with ⌘-click, ⇧-click or ⌘A, and what can be done to them at once. */
    selection: {
      label: 'Selected chats',
      count: (n: number) => `${n} selected`,
      delete: (n: number) => (n === 1 ? 'Delete chat' : `Delete ${n} chats`),
      export: (n: number) => (n === 1 ? 'Export as Markdown' : `Export ${n} chats as Markdown`),
      clear: 'Clear selection',
      clearTitle: (key: string) => `Clear selection (${key})`,
    },
    projects: {
      heading: 'Projects',
      add: 'Add a project folder',
      empty: 'Open a folder to work in',
      permissionsLabel: (name: string) => `Permissions for ${name}`,
      permissionsTitle: 'What agents may do in this folder',
      newChatIn: (name: string) => `New chat in ${name}`,
      removeLabel: (name: string) => `Remove ${name} from projects`,
      removeTitle: 'Remove from projects (the folder and its chats stay)',
      noChats: 'No chats yet',
      /** The armed remove button: the second click removes the project from the list. */
      removeConfirm: 'Yes, remove',
    },
    /** `combo` is the New chat shortcut, written for this platform. */
    empty: (combo: string) => `No chats yet. Start one with New chat (${combo}).`,
    noMatches: (query: string) => `No chats match “${query}”.`,
    searchingMessages: 'Searching messages…',
    nav: { crews: 'Crews', compare: 'Compare crews', settings: 'Settings' },
    theme: (theme: string, next: string) => `Theme: ${theme}. Switch to ${next}`,
  },

  markdown: {
    /** Code block header when the fence names no language. */
    codeFallback: 'code',
    copy: 'Copy',
    copied: 'Copied',
  },

  artifactViewer: {
    tabs: {
      preview: 'Preview',
      rendered: 'Rendered',
      source: 'Source',
      code: 'Code',
      changesFrom: (version: number) => `Changes from v${version}`,
    },
    version: 'Version',
    versionOption: (version: number, author: string) => `v${version} · ${author}`,
    copy: 'Copy',
    copyMarkdown: 'Copy markdown',
    copied: 'Copied',
    download: 'Download',
    /** File name for a download when the artifact path has none. */
    downloadName: 'artifact',
    open: 'Open',
    by: 'by',
    previewOf: (name: string) => `Preview of ${name}`,
    noPreview:
      'This Myrmidon has no preview address for this device yet, so here is the code. docs/remote.md explains how to add one.',
  },

  /** The workspace's Explorer: the project folder as a tree, like an editor's. */
  explorer: {
    label: (project: string) => `Files in ${project}`,
    filter: 'Find a file by name',
    filterPlaceholder: 'Find a file…',
    refresh: 'Refresh',
    collapseAll: 'Collapse folders',
    loading: 'Loading…',
    empty: 'This folder is empty',
    noMatches: (q: string) => `No file names contain “${q}”`,
    moreMatches: 'More files match; type more of the name to narrow it down.',
    truncated: 'This folder has more files than are shown.',
    /** A folder holding changed or new files. */
    changedInside: 'Has changes',
    ignored: 'Ignored by git',
    conflict: 'Conflict',
    /** Marks a file the crew changed in this chat. */
    editedHere: 'Changed in this chat',
  },

  /** A file in the chat's project folder, opened from a step, an approval or the change list. */
  projectFile: {
    /** Under the file's name: whose folder, and that this is the file as it is now (not as an agent left it). */
    where: (project: string) => `In ${project}, as it is now`,
    open: (path: string) => `Open ${path}`,
    copy: 'Copy',
    copied: 'Copied',
    /** The Files view's list of project files the crew changed in this chat. */
    changedIn: (project: string) => `Changed in ${project}`,
  },

  audit: {
    kinds: {
      all: 'All',
      file: 'Files',
      url: 'URLs',
      command: 'Commands',
      search: 'Searches',
      other: 'Other',
    },
    kindsLabel: 'What to show',
    /** Why a tool call was stopped, shown in brackets after it. */
    stoppedBy: {
      person: 'you denied it',
      timeout: 'no answer in time',
      hook: 'a hook blocked it',
      safety: 'flagged',
    },
    empty: {
      title: 'Nothing touched yet',
      body: 'Every file, URL and command the agents use is listed here, with who used it and whether it worked.',
    },
    stopped: (n: number) => `Stopped (${n})`,
    agentFallback: 'agent',
    filter: { placeholder: 'Filter by path, URL or command', label: 'Filter' },
    agentFilter: { label: 'Agent', all: 'All agents' },
    summary: (shown: number, total: number, calls: number) => `${shown} of ${total} · ${calls} calls`,
    noMatches: 'Nothing matches.',
    failed: (n: number) => `${n} failed`,
    call: { running: 'running', ok: 'ok', failed: 'failed' },
    openLink: 'Open link',
  },

  agentSheet: {
    label: (name: string) => `${name} details`,
    close: 'Close',
    leadBadge: 'lead',
    sections: {
      role: 'Role',
      focus: 'Focus',
      workingOn: 'Working on',
      latestThinking: 'Latest thinking',
      soFar: 'So far',
      files: 'Files',
      activity: (n: number) => `Activity · ${n}`,
    },
    /** Shown under Role/Focus when the agent joined without a focus of its own. */
    defaultFocus: {
      lead: 'Plans the work, brings in crewmates, and answers you.',
      worker: 'Picks up tasks from the board.',
    },
    reasoning: 'Reasoning',
    stats: { turns: 'turns', tokens: 'tokens', tools: 'tools', tasks: 'tasks' },
    nothingYet: 'Nothing from this agent yet. Its steps show here as it works.',
  },

  approvals: {
    /** What an agent asked to do, as a verb phrase after "wants to". */
    actions: {
      shell: 'run a command',
      file: 'change a file',
      read: 'read a folder outside the sandbox',
      use: (tool: string) => `use ${tool}`,
    },
    approval: {
      wantsTo: (action: string) => `wants to ${action}`,
    },
    /** Folders sandboxed agents may read for the rest of a chat, from a read request's card, and their chips. */
    reads: {
      approveAll: 'Allow reading it in this chat',
      /** On a request to read a folder of keys or sign-ins (~/.ssh, ~/.aws…), which may be allowed once or for this chat. */
      sensitive:
        'This folder holds keys or sign-ins. Agents can read anything in it, and what they read can end up in a reply or leave over the network. Allow it only if the task needs it.',
      allowed: (folder: string) => `Agents may read ${folder} for the rest of this chat`,
      chip: (name: string) => `Reads ${name}`,
      chipTitle: (folder: string) => `Agents may read ${folder} in this chat (never change it)`,
      revoke: (folder: string) => `Stop agents reading ${folder}`,
      revoked: (folder: string) => `${folder} is hidden from agents again`,
    },
    /** What became of a call once decided, as the one line it leaves in the chat. */
    decided: {
      approved: (what: string) => `Allowed: ${what}`,
      approvedEdited: (what: string) => `Allowed your version: ${what}`,
      denied: (what: string) => `Denied: ${what}`,
      timedOut: (what: string) => `Not answered in time: ${what}`,
      stopped: (what: string) => `Not run, the run stopped: ${what}`,
      withNote: (line: string, note: string) => `${line} · ${note}`,
    },
    /** A change shown in full before it happens. */
    review: {
      edit: 'Edit',
      editLabel: (field: string) => `Edit ${field}`,
      preview: 'Show changes',
      edited: 'edited',
      approveEdited: 'Allow your version',
      note: (agent: string) => `Note for ${agent} (optional)`,
      noteLabel: 'Note',
      unchanged: 'No changes to the file',
      moreLines: (n: number) => `${n} unchanged lines`,
    },
    login: {
      needsSignIn: 'needs you to sign in to',
      instructions: (agent: string) =>
        `Open ${agent}’s browser, choose Take control, sign in, then Hand back. The agent never sees your password, and the sign-in is kept for later runs.`,
      openBrowser: (agent: string) => `Open ${agent}’s browser`,
    },
    memory: {
      wantsToRemember: 'wants to remember',
      forProject: ' for this project',
      everyChat: ' in every chat',
      why: (why: string) => `Why: ${why}`,
      discard: 'Discard',
      keep: 'Keep',
      kept: 'Kept: later chats start with it',
    },
    /** A skill a reviewer proposed from finished work. */
    skill: {
      learned: 'Learned a skill',
      improve: 'Improve the skill',
      why: (why: string) => `Why: ${why}`,
      description: 'When to use it',
      instructions: 'Instructions',
      edit: 'Edit',
      preview: 'Preview',
      discard: 'Discard',
      keep: 'Keep',
      kept: (name: string) => `Kept ${name}: every chat can use it now`,
      discarded: 'Discarded',
    },
  },

  folderPicker: {
    title: 'Open a project folder',
    intro:
      "Agents in this project's chats work in the folder: they read and edit its files and run commands there. A new folder starts on Ask first: each change and command waits for you until you change its permissions.",
    useFolder: 'Use this folder',
    path: { placeholder: '~/code/my-app', label: 'Folder path' },
    go: 'Open',
    empty: 'No sub-folders here.',
    added: (name: string) => `Added ${name}`,
    /** On the "Added" toast while a chat is open: that chat stays where it was. */
    startChat: (name: string) => `Start a chat in ${name}`,
    /** The composer's project control. */
    pill: {
      worksIn: (name: string, mode: string) => `Works in ${name}${mode ? ` (${mode})` : ''}`,
      title: 'Work in a project folder',
      none: 'No project',
      label: 'Project folder',
      noneOption: 'No project (private working folder only)',
      open: 'Open a folder…',
    },
  },

  questions: {
    /** Per question, shown only when there are several; the footer button skips them all. */
    skip: 'Skip this one',
    unskip: 'Answer',
    skipAll: (n: number) => (n === 1 ? 'Skip, you decide' : 'Skip all, you decide'),
    send: (n: number) => (n === 1 ? 'Send answer' : 'Send answers'),
    sending: 'Sending…',
    /** The card's footer once answered: the answer lives in the card, not in a message of its own. */
    answered: 'Answered',
    readBy: (names: readonly string[]) => `Read by ${names.join(', ')}`,
    pickAny: 'Pick any that apply',
    other: 'Other: type your own answer',
    /** Placeholder once the person picked an option that means they will type the rest. */
    typeHere: 'Type it here',
    otherFor: (question: string) => `Your own answer to: ${question}`,
    /**
     * An option label that means the person will type the answer ("Other", "Adjust: I'll type what to change");
     * picking it moves to the text box. Labels only, and narrowly: an option that merely says what the agent will
     * write ("I'll write a summary") is an answer.
     */
    typesOwn: /^(other|something else)\W*$|\b(I['’]?ll|I will|let me) type\b|\btype (my|your|our) own\b/i,
    plan: 'Plan',
    /** A plan shown for approval with no questions to answer alongside it. */
    approvePlan: {
      button: 'Approve plan',
      /** What the agent reads when the person approves. */
      text: 'The plan is approved: go ahead.',
      hint: 'To change it, write what to change in the message box.',
    },
    /** What the agent reads for a skipped question. */
    skippedAnswer: '(skipped: use your judgment)',
  },

  pluginSlot: {
    failed: (plugin: string, error: string) => `The ${plugin} plugin failed here: ${error}`,
  },

  roundChanges: {
    failed: (project: string) => `Couldn’t check what changed in ${project}. Your files are untouched.`,
    retry: 'Try again',
    /** "Rewound <project> to before this run", split around the project name. */
    rewound: { before: 'Rewound', after: 'to before this run' },
    files: (n: number) => `${n} file${n === 1 ? '' : 's'}`,
    changedIn: (project: string) => `changed in ${project}`,
    hideDiff: 'Hide diff',
    viewDiff: 'View diff',
    undoRewind: 'Undo rewind',
    rewind: 'Rewind',
    confirm: {
      title: 'Rewind this run’s changes?',
      body: (project: string, n: number) =>
        `The ${n} file${n === 1 ? '' : 's'} this run changed in ${project} go${n === 1 ? 'es' : ''} back to before it, and files it added are removed; nothing else changes. Later edits stay unless you choose. You can undo it.`,
      skippedTitle: (n: number) =>
        `${n} file${n === 1 ? ' was' : 's were'} edited again after this run, so ${n === 1 ? 'it was' : 'they were'} kept:`,
      rewindThemToo: 'Rewind them too',
      keep: 'Keep them',
      cancel: 'Cancel',
      rewinding: 'Rewinding…',
      rewindFiles: 'Rewind files',
    },
    toast: {
      undid: (project: string) => `Undid the rewind in ${project}`,
      rewound: (n: number, project: string) => `Rewound ${n} file${n === 1 ? '' : 's'} in ${project}`,
    },
  },

  madeTools: {
    heading: 'Tools made here',
    inputs: (list: string) => `Inputs: ${list}`,
    noInputs: 'No inputs',
    source: 'Source',
    hideSource: 'Hide source',
    fromLibrary: 'from your library',
    madeBy: (agent: string) => `made by ${agent}`,
    kept: 'Kept',
    keep: 'Keep',
    keepTitle: 'Keep in your library: every new run starts with this tool',
    keptToast: (name: string) => `Kept tool_${name}: new runs start with it`,
    remove: 'Remove',
    removeLabel: (name: string) => `Remove tool_${name}`,
    removedToast: (name: string) => `Removed tool_${name} from your library`,
    confirmRemove: 'Yes, remove tool',
    /** Settings list when nothing has been kept yet. */
    empty:
      "When an agent makes itself a tool for a job, it shows in the chat's Files view. Choose Keep there and every new run starts with it.",
  },

  /**
   * The permission model: a preset at each level (global, project, chat), allow / ask / deny rules under it, and who
   * may use what. One set of words for Settings → Permissions, a project's sheet, the chat's control and approval
   * cards.
   */
  permissions: {
    title: (project: string) => `Permissions · ${project}`,
    presetsLabel: 'What agents may do',
    presets: {
      'read-only': {
        label: 'Read only',
        hint: 'Agents read, search and run commands that change nothing; no file changes.',
      },
      ask: {
        label: 'Ask',
        hint: 'Agents ask before each file change and each command that does more than look.',
      },
      auto: {
        label: 'Auto',
        hint: 'Agents edit and run commands in the sandbox; they ask before anything destructive.',
      },
      full: {
        label: 'Full access',
        hint: 'No sandbox and no asking: agents work as you on this computer. Rules still apply.',
      },
    },
    /** The first choice of a project or chat: take the level above's preset. */
    inherit: {
      global: (preset: string) => `Use global (${preset})`,
      project: (preset: string) => `Use project (${preset})`,
      hint: 'Follows the setting above it, and changes with it.',
    },
    /** Where a value comes from, after it. */
    scopes: {
      global: 'global',
      project: 'this project',
      chat: 'this chat',
      default: 'default',
    },
    from: (scope: string) => `from ${scope}`,
    /** The small mark beside a project's name. */
    mark: {
      readOnly: 'Read only for agents',
      ask: 'Agents ask before changes',
      full: 'Full access for agents',
    },
    /** Choosing Full access takes a second click. */
    confirmFull: 'Yes, give full access',
    confirmFullTitle: 'Give agents full access?',
    cancel: 'Cancel',
    readOnlyFloor: (project: string) =>
      `${project} is read only: change it in the project’s permissions to let this chat do more.`,
    /** Folders beyond the project that this project's sandboxed agents may read. */
    read: {
      label: 'Other folders agents may read here (read only), one per line, starting with ~ or /',
      hint: 'Also open in every chat: what Settings → Permissions lists. Folders with keys or other chats cannot be opened here.',
      placeholder: '~/Documents/specs',
    },
    save: 'Save',
    appliesFrom: 'Applies at once, to running chats in this project too.',
    /** Settings → Permissions. */
    page: {
      title: 'Permissions',
      intro:
        'What agents may do without asking you. Set a default here; a project or a chat can choose its own, and the nearer one wins. Rules under the preset allow, ask about or deny one tool, MCP server or command.',
      presetTitle: 'Default for every chat',
      presetNote: 'projects and chats can override it',
      sandbox: (kind: string) =>
        kind === 'none'
          ? 'No OS sandbox was found on this computer: commands only run with Full access.'
          : `The sandbox (${kind === 'sandbox-exec' ? 'macOS' : kind}) keeps commands to the project and the agent’s own files in every preset but Full access.`,
      movedFromTools: 'Presets, rules and who may use what now live in Permissions.',
      openPermissions: 'Open Permissions',
    },
    /** Who can use what: tool groups by role. */
    access: {
      title: 'Who can use what',
      note: 'tool groups for the lead and its crew',
      lead: 'Lead',
      leadHint: 'when it leads a crew',
      crew: 'Crew',
      crewHint: 'workers, crewmates, an agent alone',
      groups: {
        files: { label: 'Files', hint: 'Read, search and change files' },
        shell: { label: 'Commands', hint: 'Shell, checks, dev servers, tool making' },
        web: { label: 'Web', hint: 'Search and read pages' },
        browser: { label: 'Browser', hint: 'Its own browser: click, type, sign in' },
        mcp: { label: 'MCP tools', hint: 'Tools of your MCP servers' },
        computer: { label: 'Computer use', hint: 'Your Mac, one app at a time' },
        messaging: { label: 'Messaging', hint: 'Team chat, mail and shared notes' },
        plugins: { label: 'Plugins', hint: 'Build and switch on plugins' },
      },
      toggle: (group: string, role: string) => `${group} for the ${role.toLowerCase()}`,
      reset: 'Use the level above',
      resetLabel: (group: string, role: string) =>
        `${group} for the ${role.toLowerCase()}: use the level above`,
      leadTip:
        'The lead plans and assigns; with these on it also does hands-on work itself. Turn a group off to keep it delegating.',
    },
    /** The rules table. */
    rules: {
      title: 'Rules',
      note: 'allow, ask about or deny one thing; deny always wins',
      search: 'Find a rule',
      searchPlaceholder: 'Find a rule: shell, github, bun test…',
      add: 'Add rule',
      none: 'No rules: the preset decides. Answers you remember from approval cards appear here.',
      noMatch: 'No rule matches.',
      kinds: {
        tool: 'Tools',
        edit: 'File changes',
        command: 'Commands',
        'mcp-server': 'MCP servers',
        'mcp-tool': 'MCP tools',
      },
      kindOne: {
        tool: 'Tool',
        edit: 'File changes',
        command: 'Command prefix',
        'mcp-server': 'MCP server',
        'mcp-tool': 'MCP tool',
      },
      kindLabel: 'Kind',
      targetLabel: 'What',
      targetPlaceholder: {
        tool: 'shell',
        edit: '*',
        command: 'bun test',
        'mcp-server': 'github',
        'mcp-tool': 'mcp__github_create_issue',
      },
      targetHint: {
        tool: 'A tool by name.',
        edit: 'Every file change (writes, edits, proposed files).',
        command:
          'Commands starting with these words; * is every command. Chained commands must match in every part.',
        'mcp-server': 'Every tool of one server; * is every MCP tool.',
        'mcp-tool': 'One MCP tool by its full name.',
      },
      decisions: { allow: 'Allow', ask: 'Ask', deny: 'Deny' },
      decisionLabel: (target: string) => `Decision for ${target}`,
      decisionHeading: 'Decision',
      who: { all: 'Everyone', lead: 'Lead', crew: 'Crew' },
      whoLabel: (target: string) => `Who ${target} applies to`,
      remove: (target: string) => `Remove the rule for ${target}`,
      everyCommand: 'Every command',
      everyMcp: 'Every MCP tool',
      everyEdit: 'Every file change',
      readOnlyTool: 'read only',
      cancel: 'Cancel',
    },
    /** "Check a tool": which level and rule decide a call. */
    explain: {
      title: 'Check a tool',
      note: 'what happens when an agent uses it, and why',
      tool: 'Tool',
      command: 'Command',
      commandPlaceholder: 'bun test && git push',
      where: 'Where',
      noProject: 'A chat without a project',
      inProject: (name: string) => `A chat in ${name}`,
      outcome: { allow: 'Runs', ask: 'Asks you', deny: 'Refused' },
    },
    /** Why a call was decided as it was, as the approval card and the explainer say it. */
    why: {
      askAll: 'Someone other than you started this round, so every step asks.',
      readOnly: (where: string) => `Files are read only ${where}.`,
      preset: (preset: string, where: string, what: string) => `${preset} ${where} ${what}.`,
      rule: (where: string, decision: string, what: string) => `A rule ${where} ${decision} ${what}.`,
      ruleDecision: { allow: 'allows', ask: 'asks before', deny: 'denies' },
      presetWhat: {
        allow: 'runs this without asking',
        ask: 'asks before this',
        deny: 'does not allow this',
      },
      /** Where a preset or rule was set, as the sentence says it. */
      where: {
        default: '(the default)',
        global: 'in your settings',
        project: 'for this project',
        chat: 'for this chat',
      },
    },
    /** The chat's permission control beside the message box. */
    chat: {
      label: (preset: string) => `Permissions for this chat: ${preset}`,
      newLabel: (preset: string) => `Permissions for the new chat: ${preset}`,
      title: 'This chat',
      newTitle: 'This new chat',
      remembered: 'Remembered for this chat',
      nothing: 'Nothing yet. Choose “For this chat” on an approval card.',
      all: 'All permissions…',
      fullOnly: 'Only a device with full access can change this.',
    },
    /** The approval card's menus. */
    card: {
      allowOnce: 'Allow once',
      denyOnce: 'Deny',
      moreAllow: 'More ways to allow',
      moreDeny: 'More ways to deny',
      allowAlways: 'Don’t ask again for',
      denyAlways: 'Always deny',
      rememberIn: 'Remember for',
      scopes: { chat: 'This chat', project: 'This project', global: 'Everywhere' },
      scopeHint: { chat: 'Until you remove it', project: 'Every chat in this project', global: 'Every chat' },
      target: {
        command: (prefix: string) => `${prefix} …`,
        everyCommand: 'every command',
        edit: 'file changes',
        mcpTool: (tool: string) => tool,
        mcpServer: (server: string) => `everything from ${server}`,
        everyMcp: 'every MCP tool',
        tool: (tool: string) => tool,
      },
      remembered: (what: string, scope: string) => `Remembered: ${what} · ${scope.toLowerCase()}`,
      /** Joins the parts of a compound command remembered together. */
      and: ' and ',
    },
  },

  /** Agents running without the sandbox: the warning before it is given, and the badge on chats that have it. */
  /** Computer use: agents seeing and controlling the person's Mac through Cua Driver. */
  computerUse: {
    title: 'Computer use',
    intro:
      'Agents can see your Mac and use its apps with the mouse and keyboard, as you would: for native apps, simulators and tools with no other way in. They use it only after you approve each app in the chat, and you can stop them at any time.',
    unsupported: 'Computer use runs on macOS only.',
    switchLabel: 'Let agents use my Mac',
    switchHint: 'Off by default. Chats from channels never get it.',
    turnOn: 'Turn on',
    turnOnName: 'Turn on computer use',
    confirmOn: 'Yes, let agents use my Mac',
    warning:
      'Agents will see the windows of apps you approve and can click and type in them as you. What they see on screen can try to trick them; approve only apps the task needs, and watch while they work.',
    turnOff: 'Turn off',
    engineTitle: 'Engine',
    engineNote: 'What agents use your Mac through.',
    engines: {
      cua: {
        label: 'Cua Driver',
        hint: 'One app at a time, each approved once per chat, with view-only and click-only apps. The default.',
      },
      omp: {
        label: 'omp desktop engine',
        hint: 'Agents write short scripts against every window and its accessibility tree (oh-my-pi, MIT). Looking is approved once per chat; every script that clicks, types or opens an app asks first, unless you allow it for the chat. Scripts run in Myrmidon itself, outside the sandbox.',
      },
    },
    driverTitle: 'Cua Driver',
    driverNote: 'The open-source driver agents use your Mac through (trycua, MIT).',
    driverStates: {
      unsupported: 'Not available on this computer',
      missing: 'Not installed',
      installing: 'Downloading…',
      ready: 'Installed',
      starting: 'Starting…',
      running: 'Running',
      error: 'Could not install or start',
    } as Record<string, string>,
    installedAt: (version: string | undefined, own: boolean) =>
      `${version ? `Version ${version}` : 'Installed'}${own ? ', installed by Myrmidon' : ', your own install'}`,
    install: (size: string) => `Install (${size})`,
    reinstall: 'Reinstall',
    installHint: (version: string, size: string) =>
      `Downloads Cua Driver ${version} from GitHub (${size}), checks it, and keeps it in Myrmidon's folder. Nothing runs until an agent first needs your Mac.`,
    progress: (done: string, total: string) => `${done} of ${total}`,
    grantsTitle: 'macOS permissions',
    grantsNote: 'macOS asks you for these, for Myrmidon itself (no second app).',
    grants: {
      screenRecording: {
        label: 'Screen Recording',
        hint: 'Lets agents see the windows of apps you approve.',
      },
      accessibility: { label: 'Accessibility', hint: 'Lets agents click, type and scroll in them.' },
    },
    granted: 'Granted',
    notGranted: 'Not granted',
    grant: 'Open System Settings',
    restartNote:
      'After you grant one, macOS may need Myrmidon to restart before it sees it: restart the driver here, or quit and reopen Myrmidon (or the terminal running it).',
    restart: 'Restart driver',
    restarted: 'Driver restarted',
    unknownGrants: 'Myrmidon could not read these from macOS.',
    tiersTitle: 'How much agents may do',
    tiers: [
      'Browsers and trading apps: view only (agents use their own browser for websites).',
      'Terminals and code editors: click only, unless you give full control in the chat.',
      'Everything else: see, click and type.',
      'Finder, terminals and System Settings show a warning before you approve them. Myrmidon itself is never shown to agents.',
    ],
    ompTiers: [
      'Looking (window lists, screenshots, accessibility trees, the clipboard): you approve it once per chat, for every window on your screen, Myrmidon’s too.',
      'Scripts that click, type or open apps: you see each script and approve it, or allow them for the chat from its card.',
      'No app is view-only here: the per-app limits apply to Cua Driver only.',
    ],
    appsTitle: 'Apps you allowed in chats',
    appsNote: 'Each chat asks once per app; take one back here.',
    noApps: 'No chat has been allowed an app yet.',
    tier: { view: 'View only', click: 'Click only', full: 'Full control' } as Record<string, string>,
    revoke: 'Take back',
    revoked: (app: string) => `${app} taken back`,
    banner: (agent: string, app: string) => `${agent} is controlling your Mac in ${app}`,
    bannerMany: (n: number) => `${n} agents are controlling your Mac`,
    escHint: 'Press Esc to stop',
    stop: 'Stop',
    stopped: 'Computer use stopped',
    notifyTitle: 'Myrmidon is using your Mac',
    notifyBody: 'Press Esc to stop.',
    blocked: {
      install: 'An agent wants to use your Mac, but Cua Driver is not installed yet.',
      grants: (missing: string) =>
        `An agent wants to use your Mac, but macOS has not given Myrmidon ${missing} yet.`,
      open: 'Set up computer use',
    },
  },

  fullAccess: {
    badge: 'Full access',
    title: 'This chat runs without the sandbox: its agents can read and change anything you can',
    warning:
      "Agents can then read your files, change anything you can, and use your network and accounts. Myrmidon's undo and rewind only cover project folders.",
  },

  taskBoard: {
    lanes: {
      inProgress: 'Working',
      submitted: 'In review',
      rejected: 'Needs rework',
      pending: 'Waiting',
      verified: 'Done',
    },
    /** How long a card has sat in its lane. */
    inLaneFor: (duration: string) => `for ${duration}`,
    after: (tasks: string) => `after ${tasks}`,
  },

  shellTerminal: {
    /** Why the shell ended when the server gave no reason. */
    closed: 'The shell closed.',
    newShell: 'New shell',
  },

  folds: {
    collapseAll: 'Collapse all',
    expandAll: 'Expand all',
  },

  round: {
    mode: {
      answer: 'Direct answer',
      solo: 'Solo',
      swarm: 'Swarm',
      orchestrated: 'Orchestrated',
    },
    pending: {
      thinking: 'Thinking',
      seconds: (s: string) => `${s}s`,
    },
    /** The pill back to the bottom of the chat once the reader scrolled up. */
    jump: {
      fresh: 'New activity',
      latest: 'Jump to latest',
    },
    files: 'Files',
    fileTitle: (version: number | undefined, size: string, author: string | undefined) =>
      `v${version} · ${size}B · ${author}`,
    fileVersion: (version: number | undefined) => `v${version}`,
    message: {
      /** Before the names of the crewmates the person wrote to directly. */
      to: 'To',
      steer: 'Sent now',
      queued: 'Sent when done',
      readBy: (names: string) => `Read by ${names}`,
      steerLive: 'joins the next step',
      /** A message the person said aloud on a voice call. */
      saidOnCall: 'Said on a call',
      queueLive: 'waits until the current work is done',
      notRead: 'not read before the run ended',
      copyMessage: 'Copy message',
    },
    agent: {
      inspect: (name: string) => `What ${name} is doing`,
      finalAnswer: 'final answer',
      checkIn: 'check-in',
      meanwhile: 'Meanwhile: ',
      meanwhileHint: 'Reply below to change it; the work keeps going.',
      copied: 'Copied',
      copy: 'Copy',
      /** Read out once while a reply streams in, instead of every chunk of it. */
      replying: (name: string) => `${name} is replying`,
      /** A finished reply, read out once it lands. */
      said: (name: string, text: string) => `${name}: ${text}`,
    },
    thoughts: {
      thinkingFor: (time: string) => `Thinking for ${time}`,
      thoughtFor: (time: string) => `Thought for ${time}`,
      times: (n: number) => `${n} times`,
    },
    lead: {
      thinking: 'Thinking',
      waiting: 'Waiting for your reply',
      /** A round that ended on a question the person has since answered. */
      asked: 'Asked you',
      /** The run is paused on a call the person has to approve. */
      approval: 'Waiting for you to allow a step',
      toTeam: 'Bringing in crewmates',
      toAgent: 'Handing this to one agent with every tool',
      doneIn: (time: string) => `Done in ${time}`,
      failed: 'Failed',
      stopped: 'Stopped',
      tokens: (n: string) => `${n} tokens`,
      steps: (n: number) => `${n} step${n === 1 ? '' : 's'}`,
      detailsTitle: 'Map, replay and transcripts of this run',
      detailsLabel: "Open the run's details",
      learnTitle: 'Learn a skill from how this was done',
    },
    helpers: {
      /** Each crewmate as "nova (researcher)". */
      broughtIn: (helpers: string[]) =>
        `Brought in ${helpers.length > 1 ? `${helpers.slice(0, -1).join(', ')} and ${helpers.at(-1)}` : helpers[0]}`,
      helper: (name: string, specialty?: string) => (specialty ? `${name} (${specialty})` : name),
      crew: 'Open the crew',
    },
    serverTitle: (command: string, agent: string) => `${command} (started by ${agent})`,
    spend: {
      /** `used` already carries the limit, e.g. "120k / 500k". */
      tokens: (used: string) => `${used} tokens`,
      left: (time: string) => `${time} left`,
    },
    run: {
      working: 'Working on it',
      doneIn: (time: string) => `Done in ${time}`,
      paused: 'Paused for your reply',
      toTeam: 'Handed to a crew',
      toAgent: 'Handed to one agent with every tool',
      failed: 'Run failed',
      stopped: 'Run stopped',
      agents: (n: number) => `${n} agent${n === 1 ? '' : 's'}`,
      steps: (n: number) => `${n} steps`,
      tasks: (done: number, total: number) => `${done}/${total} tasks`,
      crewTitle: 'Crew map, replay, and agent transcripts',
      crew: 'Crew',
      showFewer: 'Show fewer steps',
      showAll: (n: number) => `Show all ${n} steps`,
    },
  },

  modelFailure: {
    tooLong: (model: string) => `Too long for ${model}`,
    declined: (model: string) => `${model} declined to continue`,
    couldntAnswer: (model: string) => `${model} couldn't answer`,
    windowTooSmall: (model: string, tokens: string, window: string) =>
      `${model} turned down about ${tokens} tokens, though its window is listed as ${window}. Its real window is probably smaller: correct it in Settings → Models, or continue on another model.`,
    conversationTooLong: (tokens: string, model: string, window: string) =>
      `This chat is about ${tokens} tokens, and ${model} holds ${window}, even after older messages were summarized. Continue on a model with a bigger window.`,
    noLongerFits: (model: string) =>
      `This chat no longer fits ${model}'s context window, even after older messages were summarized.`,
    refusal: "The provider's safety filter stopped this reply. Another model can pick up from here.",
    error: 'The provider returned an error. Another model can pick up from here, or try again.',
    providerMessage: 'Provider message',
    continueWith: 'Continue with',
    wontFit: (window: string) => `Under ${window}: this chat won't fit`,
    continuing: 'Continuing…',
    continue: 'Continue',
    retrying: 'Trying again…',
    summarizeAndRetry: 'Summarize and try again',
    tryAgain: 'Try again',
    noModel: (window: string) => `No model with ${window} or more is set up. Add one in Settings → Models.`,
    kept: 'The work so far is kept; the failed reply is not.',
  },

  outcome: {
    reviewed: 'Reviewed',
    score: (score: string) => `score ${score}`,
    whyPassed: 'Why it passed',
    movedTo: (target: string) => `Moved to ${target}`,
    aTeam: 'a crew',
    oneAgent: 'one agent with every tool',
    escalatedNext: 'The next run picks it up with these files and notes.',
    effects: (n: number) => `Already done before it stopped (${n})`,
    effectsHint:
      'These reached outside Myrmidon and a rewind cannot undo them. Resuming tells the agents, so they check before repeating any.',
    waiting: 'Waiting for your reply',
    waitingHint: 'Answer below and the crew continues where it left off, with its files.',
    failed: 'Failed',
    stopped: 'Stopped',
    /** In place of the runtime's reason when the person stopped the run. */
    stoppedByYou: 'You stopped this run',
    lastVerification: 'Last review',
    resuming: 'Resuming…',
    resume: 'Resume',
    starting: 'Starting…',
    retry: 'Try again',
    changesAsked: 'The reviewer asked for changes',
    fixing: 'the crew is fixing them',
    feedback: 'Feedback',
  },

  workspace: {
    views: {
      files: 'Files',
      explorer: 'Explorer',
      git: 'Git',
      shell: 'Terminal',
      computer: 'Computer',
      tasks: 'Tasks',
      team: 'Crew',
      mail: 'Mail',
      terminal: 'Agent commands',
      activity: 'Activity',
      audit: 'Audit',
    },
    roundLabel: 'Run',
    roundOption: (n: number) => `Run ${n}`,
    label: 'Workspace',
    resize: 'Resize workspace',
    viewLabel: 'Workspace view',
    viewsLabel: 'Workspace views',
    close: 'Close panel',
    closeTitle: 'Close panel (⌘J)',
    /** Under the shell's title; `where` is the project's name or `~`. */
    shellCwd: (where: string) => `${where} · your shell`,
    files: {
      emptyTitle: 'No files yet',
      emptyBody: 'Everything the crew publishes appears here, with every version kept.',
      meta: (versions: number, size: string) => `${versions} version${versions === 1 ? '' : 's'} · ${size}B`,
    },
    tasks: {
      emptyTitle: 'No tasks',
      emptyBody: 'Tasks appear when a crew splits the work into parts.',
      plan: (agent: string) => `Plan · ${agent}`,
      done: (done: number, total: number) => `${done} of ${total} done`,
      progress: (active: number, review: number, waiting: number) =>
        `${active} active · ${review} in review · ${waiting} waiting`,
      layout: 'Task layout',
      list: 'List',
      board: 'Board',
      after: (ids: string) => `after ${ids}`,
    },
    /** The same words as the task board's lanes. */
    taskStatus: {
      pending: 'waiting',
      in_progress: 'working',
      submitted: 'in review',
      verified: 'done',
      rejected: 'needs rework',
      deleted: 'deleted',
    },
    team: {
      emptyTitle: 'No one on the crew yet',
      emptyBody: 'The lead and any crewmates it brings in appear here once the work starts.',
      workingOn: (subject: string) => `Working on ${subject}`,
      turns: 'turns',
      tokens: 'tokens',
      tools: 'tools',
    },
    shell: {
      emptyTitle: 'No shell commands yet',
      emptyBody:
        'Agents run commands in a sandbox that writes only to their working folder and, unless the project is Read-only, the project, and cannot see the rest of your home.',
      running: 'running…',
      noOutput: '(no output)',
    },
    activityEmpty: 'No steps yet: each one the crew takes shows here',
    mail: {
      emptyTitle: 'No messages yet',
      emptyBody: 'The crew chat, group chats and messages between agents show up here.',
      count: (n: number) => `${n} message${n === 1 ? '' : 's'}`,
      filterLabel: 'Show messages for',
      everyone: 'Everyone',
      open: (name: string) => `Open ${name}`,
      /** The chat everyone on the crew is in. */
      team: 'Crew',
      members: (n: number) => `${n} people`,
      back: 'All messages',
      /** Whether the agent it was sent to has read a message. */
      read: 'Read',
      unread: 'Not read yet',
      /** Messages in a conversation the person has not opened yet. */
      newCount: (n: number) => `${n} new`,
    },
    /** A panel view's button with its count beside the icon, so the name holds the number shown. */
    viewWithCount: (view: string, count: string) => `${view}, ${count}`,
  },

  computer: {
    modes: {
      browser: 'Browser',
      terminal: 'Terminal',
      editor: 'Editor',
    },
    emptyTitle: 'Nothing on screen yet',
    emptyBody:
      'When an agent browses, runs commands, or writes files, you can watch it here, follow its cursor, and take control of its browser.',
    follow: 'Follow',
    terminal: 'Terminal',
    running: 'running…',
    editor: (path: string) => `Editor · ${path}`,
    edited: ' (edit)',
    publishedFromScratch: '(published from its private working folder)',
    agentsComputer: (agent: string) => `${agent}’s computer`,
    blankPage: 'blank page',
    youHaveControl: 'you have control',
    agentBrowsing: 'agent browsing',
    ended: 'ended',
    handBack: (agent: string) => `Hand back to ${agent}`,
    takeControl: 'Take control',
    exitFullScreen: 'Exit full screen',
    fullScreen: 'Full screen',
    browserLabel: (agent: string, page: string) => `${agent}'s browser: ${page}`,
    sessionEnded: 'The session ended. This is the last screen.',
    connecting: 'Connecting to the browser…',
    actions: {
      open: 'open',
      click: 'click',
      type: 'type',
      press: 'press',
    },
    stepLabel: (n: number, action: string) => `Step ${n}: ${action}`,
    previousStep: 'Previous step',
    nextStep: 'Next step',
    live: 'Live',
    stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
    recorded: (n: number, agent: string) =>
      `${n} recorded step${n === 1 ? '' : 's'} · scrub back to replay what ${agent} did`,
    /** Under the page while the person drives it; `paste` and `leave` are shortcuts such as ⌘V and ⌘. */
    controlHint: (agent: string, paste: string, leave: string) =>
      `Click and type in the page as usual; ${paste} pastes. ${leave} leaves the page. ${agent} waits until you hand it back.`,
  },

  app: {
    /** Title of the desktop notification when a run finishes in the background. */
    fileTooLarge: (name: string) => `${name} is larger than 10 MB`,
    /** The Markdown file written by /export. */
    export: {
      round: (n: number) => `Run ${n}`,
      you: 'You',
      files: (list: string) => `Files: ${list}`,
      fallbackName: 'chat',
    },
    toasts: {
      /** Stays until the review answers, which can take minutes; the chat is named since the person may move on. */
      learning: (title: string) => `Reading “${title}” for a skill worth keeping…`,
      stillLearning: (title: string) => `Still reading “${title}” for a skill`,
      learned: (name: string, title: string) =>
        `Proposed a skill from “${title}”: ${name}. Keep or discard it in the chat.`,
      nothingToLearn: (title: string) => `Nothing in “${title}” worth keeping as a skill.`,
      learnFailed: (title: string, reason: string) => `Couldn’t learn a skill from “${title}”: ${reason}`,
      skillsArchived: (names: string[]) =>
        names.length === 1
          ? `Archived the learned skill ${names[0]}: nobody used it for a while.`
          : `Archived ${names.length} learned skills nobody used for a while.`,
      reviewSkills: 'Review',
      openChatToLearn: 'Open a chat to learn a skill from it',
      roundDone: (title: string) => `“${title}” is done`,
      roundEnded: (title: string, status: string) => `“${title}” ${status}`,
      paused: 'paused',
      chooseLeadModel: 'Choose a lead model first',
      queued: 'Sent: the crew reads it once the current work is done',
      steering: 'Sent: the crew reads it at its next step',
      continuingOnNewModel: 'Continuing on the new model',
      resuming: 'Resuming where it left off',
      notRunningSendNormally: 'Nothing is running; send it as a normal message',
      notRunning: 'Nothing is running',
      stillRunning: 'Still running',
      nothingToRetry: 'Nothing to run again yet',
      openChatToRename: 'Open a chat to rename it',
      renamed: 'Renamed',
      modeUsage: 'Use /mode orchestrated or /mode swarm',
      modeSwarm: 'Swarm: equal crewmates',
      modeOrchestrated: 'Orchestrated: a lead with crewmates',
      noModelMatches: (query: string) => `No model matches “${query}”`,
      modelSwitched: (agents: string, model: string) => `${agents} now on ${model}, from the next step`,
      leadModel: (model: string) => `Lead model: ${model}`,
      thinkingUsage: 'Use /thinking low, medium, high, or auto',
      thinkingAuto: 'Thinking: each role decides',
      thinkingLevel: (level: string) => `Thinking: ${level} while the crew works`,
      openChatToExport: 'Open a chat to export it',
      stopping: 'Stopping the crew…',
      deleted: (title: string) => `Deleted “${title}”`,
      deletedMany: (n: number) => `Deleted ${n} chats`,
      undoDelete: 'Undo',
      undoDeleteTitle: (keys: string) => `Bring the chat back (${keys})`,
      undoDeleteManyTitle: (keys: string) => `Bring the chats back (${keys})`,
      deleteFailed: (title: string, reason: string) => `Couldn’t delete “${title}”: ${reason}`,
      projectRemoved: (name: string) => `Removed ${name} from projects; its folder and chats are untouched`,
    },
    /** The window or tab title, with how many chats wait for the person as a mail app counts unread mail. */
    documentTitle: (needYou: number) => (needYou > 0 ? `(${needYou}) Myrmidon` : 'Myrmidon'),
    titles: {
      newTask: 'New chat',
      crews: 'Crews',
      compare: 'Compare crews',
    },
    resizeSidebar: 'Resize sidebar',
    /** One calm line under the toolbar while the server is not answering; it clears by itself. */
    reconnecting: "Can't reach Myrmidon. Reconnecting…",
    /** On the entry page while no model can lead a crew yet. */
    setup: {
      title: 'Connect a model',
      body: 'The crew needs a model to think with. Sign in to a provider or add an API key, and it can start.',
      action: 'Connect a model',
      /** On a chats-only device, which cannot open Settings. */
      askOwner:
        'The crew needs a model to think with. Whoever set up this Myrmidon can connect one in Settings.',
    },
    /** A link to a chat that is not on this machine (deleted, or from another gateway). */
    chatNotFound: {
      title: 'Chat not found',
      body: 'It may have been deleted, or it belongs to another gateway.',
      action: 'New chat',
    },
    chatsOnly: 'This device can use chats only.',
    /** A chat link opened while the chat list will not load. */
    chatFailed: "Couldn't load this chat",
    crewsFailed: "Couldn't load crews",
    showSidebar: 'Show sidebar',
    showSidebarTitle: (combo: string) => `Show sidebar (${combo})`,
    newTask: 'New chat',
    newTaskTitle: (combo: string) => `New chat (${combo})`,
    crewButton: 'Crew',
    crewButtonTitle: 'This chat’s crew: agents, tool calls, tasks, replay',
    composer: {
      status: 'Crew is working…',
      messagePeers: 'Message the crewmates while they work…',
      messageLead: 'Message the lead while it works…',
      followUp: 'Ask a follow-up or request changes…',
      /** Added when the chat has a crew: typing @ and a name writes to that crewmate directly. */
      mentionHint: ' (@name writes to a crewmate)',
      newTask: 'Describe what you want done…',
      /** In place of the message box until the models it offers have loaded. */
      loading: 'Loading models…',
      failed: "Couldn't load your models.",
      retry: 'Try again',
    },
    deleteChat: {
      title: 'Delete chat?',
      quotedTitle: (title: string) => `“${title}”`,
      /** Follows the quoted chat title. */
      body: (rounds: number) =>
        ` and its ${rounds === 1 ? 'run' : `${rounds} runs`} will be permanently removed from this Myrmidon: messages, files, logs, and agent transcripts. You can still undo it for a few seconds.`,
      stillRunning: 'This chat is still running. It will be stopped first.',
      cancel: 'Cancel',
      confirm: 'Delete chat',
      /** Several chats at once. */
      titleMany: (n: number) => `Delete ${n} chats?`,
      bodyMany: (n: number) =>
        `These ${n} chats and their runs will be permanently removed from this Myrmidon: messages, files, logs, and agent transcripts. You can still undo it for a few seconds.`,
      stillRunningMany: (n: number) =>
        n === 1
          ? 'One of these chats is still running. It will be stopped first.'
          : `${n} of these chats are still running. They will be stopped first.`,
      confirmMany: (n: number) => `Delete ${n} chats`,
      /** Ends the list of titles when it is cut short. */
      andMore: (n: number) => `and ${n} more`,
    },
    crewConsole: 'Crew',
    noCrews: 'No crews yet. Send a message in a chat and its crew shows here.',
    crewSelect: 'Crew',
    /** The first stop on the page for keyboard users, shown only while focused. */
    skipToComposer: 'Skip to message box',
  },

  colonyScreen: {
    /** Names shown in the activity stream for events that no agent sent. */
    agents: {
      system: 'system',
      you: 'you',
      observer: 'check-in',
      colony: 'crew',
      reviewer: 'reviewer',
    },
    activity: {
      postedToBoard: 'posted to the board',
      messageFromYou: 'message from you',
      finalAnswer: 'final answer to you',
      replied: 'replied to you',
      published: (name: string, version: number, size: string) => `published ${name} v${version} (${size}B)`,
      verdict: (result: string, target: string) => `${result}: ${target}`,
      broughtIn: (name: string, model: string) => `brought in ${name} (${model})`,
    },
    pass: 'Passed',
    fail: 'Failed',
    score: (score: string) => `score ${score}`,
    stats: {
      time: 'Time',
      tokens: 'Tokens',
      cost: 'Cost',
      toolCalls: 'Tool calls',
      files: 'Files',
      verdicts: 'Reviews',
    },
    agentsHeading: 'Agents',
    everyone: 'Everyone',
    agentCount: (n: number) => `${n} agents`,
    /** Turns and tokens beside each agent in the sidebar. */
    agentMeta: (turns: number, tokens: string) => `${turns}t · ${tokens}`,
    tabs: {
      activity: 'Activity',
      board: 'Board',
      tasks: 'Tasks',
      files: 'Files',
      map: 'Map',
      verdicts: 'Reviews',
    },
    noAgentActivity: 'Nothing from this agent yet',
    noActivity: 'No activity yet',
    toolInput: 'Input',
    toolOutput: 'Output',
    showLess: 'Show less',
    showMore: 'Show more',
    thinking: 'Thinking',
    noPosts: 'Nobody has posted yet',
    columns: {
      todo: 'To do',
      inProgress: 'In progress',
      inReview: 'In review',
      done: 'Done',
    },
    noTasks: 'No tasks',
    noTasksHint: 'The lead creates tasks when the work has several parts.',
    rework: 'rework',
    emptyColumn: 'Empty',
    noFiles: 'No files yet',
    versions: (n: number) => `${n} version${n === 1 ? '' : 's'}`,
    noVerdicts: 'No reviews yet',
    verdictTarget: (target: string) => `of ${target}`,
    replay: {
      stepBack: 'Step back',
      pause: 'Pause replay',
      play: 'Play replay',
      stepForward: 'Step forward',
      speed: 'Replay speed',
      position: 'Replay position',
      live: 'Live',
    },
  },

  compare: {
    noCrews: 'No crews yet. Send a message in a chat, then tick two crews here to compare them.',
    tickTwo: 'Tick two crews to see what differs between them.',
    comparing: 'Comparing…',
    columns: {
      compare: 'Compare',
      crew: 'Crew',
      status: 'Status',
      pattern: 'Mode',
      models: 'Models',
      wall: 'Time',
      tokens: 'Tokens',
      cost: 'Cost',
      turns: 'Turns',
      toolCalls: 'Tool calls',
      messages: 'Messages',
      artifactVersions: 'File versions',
      rejections: 'Changes asked',
      bestScore: 'Review score',
    },
    pick: (name: string) => `Compare ${name}`,
    /** The runtime's pattern ids, named like the composer's modes. */
    patterns: { blackboard: 'Swarm', 'lead-workers': 'Orchestrated' } as Record<string, string>,
    metrics: {
      wallTime: 'Time',
      tokens: 'Tokens',
      cost: 'Cost',
      turns: 'Turns',
      toolCalls: 'Tool calls',
      rejections: 'Changes asked',
      judgeScore: 'Review score',
    },
    judge: (passed: boolean) => `· review ${passed ? 'passed' : 'failed'}`,
    runDiff: 'What differs',
    /** Warns that two compared runs were asked to do different things. */
    differentTasks: 'These crews worked on different requests, so their numbers are not like for like.',
    close: 'Close the comparison',
    measure: 'Measure',
    versus: 'B vs A',
    toolCalls: 'Tool calls',
    showFewer: 'Show fewer',
    showAllTools: (n: number) => `Show all ${n} tools`,
    files: 'Files',
    same: 'same',
    differs: 'differs',
    onlyIn: (side: string) => `only ${side}`,
    agent: 'Agent',
    /** Follows the agent's model in the per-agent comparison. */
    agentStats: (turns: number, tokens: string, tools: number) =>
      ` · ${turns} turns · ${tokens} tok · ${tools} tools`,
    finalAnswers: 'Final answers',
    noAnswer: '(no answer)',
  },

  colonyMap: {
    turn: (n: number) => `turn ${n}`,
    tokens: (n: string) => `${n} tok`,
    noAgents: 'No agents yet. The lead and its crewmates show here once the run starts.',
    /** A link between two agents on the crew map, for screen readers. */
    link: (a: string, b: string, n: number) => `${a} and ${b}: ${n} message${n === 1 ? '' : 's'}`,
  },

  git: {
    notRepo: 'Not a git repository',
    notRepoHint:
      'This project folder has no git repository. Each run’s changes are still checkpointed and can be rewound from the chat.',
    detachedHead: 'detached HEAD',
    refresh: 'Refresh',
    openAll: 'Open all changes in the full view',
    messagePlaceholder: (branch: string) => `Message (⌘↵ to commit on “${branch}”)`,
    messageLabel: 'Commit message',
    commitStagedTitle: 'Commit the staged changes',
    commitAllTitle: 'Stage every change and commit',
    commitStaged: (n: number) => `Commit ${n} staged`,
    commitAll: 'Commit all',
    /** Toasts after an action; a commit's short hash is appended. */
    committed: 'Committed',
    discarded: 'Discarded',
    noChanges: 'No uncommitted changes.',
    sections: {
      staged: 'Staged',
      changes: 'Changes',
      untracked: 'Untracked',
      history: 'History',
    },
    unstageAll: 'Unstage all',
    unstage: 'Unstage',
    discardAll: 'Discard all changes',
    stageAll: 'Stage all changes',
    discardChanges: 'Discard changes',
    stage: 'Stage',
    stageAllUntracked: 'Stage all untracked',
    deleteFile: 'Delete file',
    noCommits: 'No commits yet.',
    discardDialog: {
      title: 'Discard changes?',
      untracked: (path?: string) => `${path} is not tracked by git, so it will be deleted.`,
      tracked: (what?: string) => `${what} go back to their last staged or committed content.`,
      fileCount: (n: number) => `${n} files`,
      cannotUndo: 'Git cannot bring this work back.',
      cancel: 'Cancel',
      deleteFile: 'Delete file',
      discard: 'Discard changes',
    },
    full: {
      uncommitted: 'Uncommitted changes',
      committedAgo: (when: string) => ` committed ${when}`,
      copiedSha: 'Copied the commit SHA',
      copySha: 'Copy the full SHA',
      fileCount: (n: number) => `${n} file${n === 1 ? '' : 's'}`,
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      noChanges: 'No changes.',
      changedFiles: 'Changed files',
      truncated: 'The diff is large; only its first 512 KB is shown.',
    },
  },

  diffView: {
    /** git's status letters and what they mean. */
    status: {
      added: { label: 'A', title: 'Added' },
      modified: { label: 'M', title: 'Modified' },
      deleted: { label: 'D', title: 'Deleted' },
      renamed: { label: 'R', title: 'Renamed' },
      untracked: { label: 'U', title: 'Untracked' },
    },
    layout: 'Diff layout',
    unified: 'Unified',
    split: 'Side by side',
    binary: 'Binary file, or nothing to show line by line.',
    /** The tag on a changed file git counts no lines for. */
    binaryTag: 'binary',
    noChanges: 'No file changes.',
    fileCount: (n: number) => `${n} file${n === 1 ? '' : 's'}`,
    collapseAll: 'Collapse all',
    expandAll: 'Expand all',
    truncated: 'The diff is large; only its first 512 KB is shown.',
  },

  settings: {
    shared: {
      cancel: 'Cancel',
      save: 'Save',
      off: 'Off',
      on: 'On',
      loading: 'Loading…',
    },
    /** Why a Settings form value is not accepted, shown under the field. */
    validation: {
      required: 'Required.',
      startWithLetter: 'Start with a letter.',
      nameChars: 'Use only lowercase letters, digits and dashes.',
      nameLength: (min: number, max: number) => `Use ${min} to ${max} characters.`,
      providerTaken: (name: string) => `There is already a provider called ${name}.`,
      specialistTaken: (name: string) => `There is already a specialist called ${name}.`,
      reserved: (name: string) => `Myrmidon uses "${name}" itself; choose another name.`,
      url: 'Enter a full address starting with http:// or https://.',
      keyRequired: 'Enter an API key, or choose None for an endpoint that needs none.',
      modelsRequired: 'List at least one model id: only OpenAI-compatible endpoints can list their own.',
      cronFieldCount: (n: number) =>
        `A schedule needs five fields (minute hour day month weekday); this has ${n}.`,
      cronBadField: (field: string, text: string) => `The ${field} field "${text}" is not valid cron.`,
      cronRange: (field: string, min: number, max: number) =>
        `The ${field} must be between ${min} and ${max}.`,
      cronNever: 'This schedule would never run: none of its months has that day.',
      cronFields: { minute: 'minute', hour: 'hour', day: 'day', month: 'month', weekday: 'weekday' },
      range: (min: string, max: string) => `Between ${min} and ${max}.`,
    },
    sections: {
      general: { label: 'General', hint: 'Motion, notifications, shortcuts' },
      appearance: { label: 'Appearance', hint: 'Light, dark and VS Code themes' },
      mascot: { label: 'You & mascot', hint: 'Your name, its look, how lively it is' },
      specialists: { label: 'Specialists', hint: 'Agents you keep and bring back' },
      devices: { label: 'Devices', hint: 'Who can use this Myrmidon' },
      gateways: { label: 'Gateways', hint: 'Other Myrmidons, one window' },
      channels: { label: 'Channels', hint: 'Telegram, Slack, email and more' },
      voice: { label: 'Voice', hint: 'Calls with your crew' },
      computer: { label: 'Computer use', hint: 'Agents on your Mac' },
      models: { label: 'Models & providers', hint: 'Models, API keys, endpoints' },
      team: { label: 'Crew & budget', hint: 'Default crew, limits, reviewer' },
      permissions: { label: 'Permissions', hint: 'What agents may do without asking' },
      tools: { label: 'Tools', hint: 'MCP servers, tool library, search' },
      skills: { label: 'Skills', hint: 'Playbooks agents load' },
      plugins: { label: 'Plugins', hint: 'Skills, commands, hooks, servers' },
      hooks: { label: 'Hooks', hint: 'Commands around every tool' },
      schedules: { label: 'Schedules', hint: 'Requests that run on their own' },
      instructions: { label: 'Instructions', hint: 'House rules for agents' },
      memory: { label: 'Memory', hint: 'What agents keep across chats' },
    },
    page: {
      back: 'Back',
      title: 'Settings',
      saving: 'Saving…',
      saved: 'All changes saved',
      /** Follows the Esc key in the header. */
      escToClose: ' to close',
      sectionPicker: 'Section',
      saveFailed: 'Couldn’t save your changes; they are still here',
      retry: 'Try again',
      groups: { setup: 'Setup', agents: 'Agents', extend: 'Extend', you: 'You', connect: 'Connect' },
      unsaved: {
        title: 'Leave without saving?',
        body: 'Your hook changes are not saved yet. If you leave now, they are lost.',
        keep: 'Keep editing',
        discard: 'Discard changes',
      },
      modelsTab: 'Your models',
      providersTab: 'Keys & providers',
      loading: 'Loading settings…',
    },
    /** Settings → the search field over the section list, like iPhone Settings. */
    search: {
      label: 'Search settings',
      placeholder: 'Search',
      results: 'Matching settings',
      clear: 'Clear search',
      /** Shown under the field while it is focused and empty. */
      empty: {
        title: 'Search every setting',
        body: 'Type what you want to change, in your own words: a setting, a provider, a theme.',
      },
      noResults: (query: string) => `No settings match “${query}”`,
      noResultsHint: 'Check the spelling, or try a more general word.',
      try: 'Try',
      suggestions: [
        'dark mode',
        'api key',
        'microphone',
        'notifications',
        'sandbox',
        'shortcuts',
        'spend limit',
      ],
      count: (n: number) => `${n} setting${n === 1 ? '' : 's'}`,
      footer: { move: 'move', open: 'open', clear: 'clear' },
      /** A result whose row the page is not showing just now. */
      notShown: (label: string) => `${label} is not on this page right now.`,
      /** A result whose row shows only once another setting is on or set up. */
      startWith: (label: string, first: string) => `${label} shows once ${first} is on or set up.`,
      /** A result set on each item of a list (each channel): the first item is shown instead. */
      openOne: (label: string) => `Open one of these to change “${label}”.`,
      /** Other words people use for a setting, beside its own label and hint. */
      keywords: {
        motion: ['animation', 'animations', 'transitions', 'accessibility', 'motion sickness'],
        notifications: [
          'notification',
          'notify',
          'alert',
          'alerts',
          'desktop notification',
          'banner',
          'done',
        ],
        chatNames: ['chat title', 'titles', 'rename chats', 'naming'],
        suggest: ['autocomplete', 'autocompletion', 'ghost text', 'predict', 'predictions', 'typing'],
        setup: ['onboarding', 'first run', 'wizard', 'get started', 'welcome'],
        shortcuts: ['shortcut', 'keyboard', 'hotkey', 'hotkeys', 'keys', 'keybindings', 'key bindings'],
        dataFolder: ['data directory', 'home folder', 'where files are', 'storage', 'myrmidon folder'],
        theme: [
          'theme',
          'dark mode',
          'light mode',
          'night mode',
          'color scheme',
          'colour scheme',
          'colors',
          'colours',
          'appearance',
          'look',
        ],
        system: ['auto', 'automatic', 'match system', 'follow system'],
        dark: ['dark mode', 'night mode', 'night'],
        light: ['light mode', 'day mode'],
        vscodeThemes: ['vs code', 'vscode', 'theme', 'themes', 'editor theme', 'color theme', 'colour theme'],
        importTheme: ['vs code', 'vscode', 'import theme', 'json theme', 'custom theme'],
        name: ['my name', 'username', 'what to call me', 'profile'],
        greeting: ['welcome line', 'hello', 'home screen line'],
        mascot: ['avatar', 'character', 'pet', 'face'],
        colour: ['color', 'tint'],
        sounds: ['sound', 'audio', 'beep', 'blip', 'mute', 'noise'],
        specialists: ['agent', 'agents', 'persona', 'personas', 'custom agent', 'subagent', 'role'],
        devices: ['phone', 'remote', 'other computer', 'pair', 'pairing', 'qr', 'access'],
        gateways: ['vps', 'server', 'remote myrmidon', 'other myrmidon', 'hub'],
        channels: ['telegram', 'slack', 'discord', 'whatsapp', 'email', 'sms', 'bot', 'messaging'],
        channelSetup: ['token', 'bot token', 'credentials', 'webhook'],
        voice: ['call', 'calls', 'talk', 'speak', 'microphone', 'mic', 'audio', 'voice chat'],
        mic: ['microphone', 'mic', 'noise', 'loudness', 'background noise', 'voice activity'],
        realtime: ['speech to speech', 'live', 'gpt realtime', 'gemini live'],
        stt: [
          'transcription',
          'transcribe',
          'dictation',
          'speech recognition',
          'whisper',
          'microphone',
          'mic',
        ],
        tts: ['voice', 'speak', 'read aloud', 'speech', 'narration'],
        phone: ['twilio', 'telephone', 'phone number', 'sms'],
        computer: ['mac', 'desktop', 'mouse', 'keyboard', 'screen', 'automation', 'control my computer'],
        models: ['model', 'llm', 'ai', 'gpt', 'claude', 'gemini'],
        apiKey: ['api key', 'api keys', 'key', 'keys', 'token', 'credentials', 'secret', 'provider'],
        subscription: [
          'subscription',
          'oauth',
          'login',
          'log in',
          'sign in',
          'claude pro',
          'claude max',
          'chatgpt plus',
        ],
        customEndpoint: [
          'local model',
          'lm studio',
          'ollama',
          'vllm',
          'openrouter',
          'openai compatible',
          'base url',
        ],
        voiceProviders: [
          'speech api key',
          'deepgram',
          'elevenlabs',
          'cartesia',
          'speech provider',
          'voice api',
        ],
        leadModel: ['default model', 'main model', 'lead model'],
        reviewer: ['review', 'judge', 'verifier', 'verification', 'check the work', 'quality'],
        helpers: ['crewmates', 'workers', 'helpers', 'subagents', 'team size', 'parallel'],
        budget: ['budget', 'cost', 'money', 'dollars', 'price', 'spend', 'limit'],
        time: ['timeout', 'duration', 'minutes', 'how long'],
        sandbox: [
          'sandbox',
          'full access',
          'yolo',
          'permissions',
          'approvals',
          'approve',
          'ask before',
          'read only',
          'safety',
          'security',
        ],
        access: ['tool groups', 'lead tools', 'crew tools', 'allow tools', 'disable tools'],
        rules: ['allow', 'deny', 'ask', 'allowlist', 'blocklist', 'command rules', 'tool rules'],
        readFolders: ['read access', 'folders', 'home folder', 'documents', 'files agents can read'],
        instructions: ['system prompt', 'prompt', 'house rules', 'custom instructions', 'rules for agents'],
        memory: ['remember', 'memories', 'facts', 'preferences', 'knowledge'],
        skills: ['skill', 'playbook', 'playbooks', 'skill.md', 'agent skills'],
        mcp: ['mcp', 'model context protocol', 'tool server', 'connectors', 'integrations'],
        webSearch: ['search engine', 'brave', 'exa', 'duckduckgo', 'google', 'internet'],
        plugins: ['plugin', 'extension', 'extensions', 'add-on', 'claude code plugin'],
        hooks: ['hook', 'pre tool use', 'post tool use', 'script', 'lint on save', 'automation'],
        schedules: ['cron', 'recurring', 'every day', 'daily', 'weekly', 'timer', 'automation', 'routine'],
      },
    },
    notify: {
      label: 'Notify me when a run finishes',
      hint: 'A desktop notification when a run is done (or stops) while Myrmidon is in the background, including scheduled ones.',
      unsupported: 'This browser does not support notifications.',
      blocked: 'Notifications are blocked for this site in your browser settings',
    },
    general: {
      title: 'General',
      intro: 'How Myrmidon feels on this device.',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      reduceMotion: 'Reduce motion',
      reduceMotionHint: 'Turn off animations and transitions.',
      suggest: 'Suggest as I type',
      suggestHint:
        'Grey text after the cursor from what you have written before: Tab takes the next word, → takes it all, Esc hides it. Worked out on this device; nothing is sent anywhere.',
      suggestModel: 'Smarter next words',
      suggestModelHint: (mb: number) =>
        `When nothing you wrote before fits, a small language model (Pythia-14M) guesses the next word. A ${mb} MB download, once; it runs on the computer Myrmidon runs on and sends nothing anywhere.`,
      suggestModelDownloading: (mb: number) => `Downloading the ${mb} MB model…`,
      suggestModelFailed: (error: string) => `The model could not be downloaded: ${error}`,
      setup: 'Setup assistant',
      setupHint: 'Go through the first-run steps again: models, crew, project, voice and the rest.',
      runSetup: 'Run setup again',
      setupStep: 'One step',
      setupStepHint: 'Open a single step on its own; when it is done you come back here.',
    },
    appearance: {
      title: 'Appearance',
      intro:
        "Myrmidon's own look, or a theme developers love from VS Code, across the whole app: chats, code, diffs and the terminal. Hover or focus a theme to try it, Esc puts yours back, and a click keeps it. Kept on this device.",
      gallery: 'Themes',
      groups: { myrmidon: 'Myrmidon', dark: 'Dark', light: 'Light', imported: 'Imported' },
      myrmidonHint: 'The default look, with its amber accent.',
      inUse: 'In use',
      by: (author: string) => `by ${author}`,
      importTitle: 'Import a VS Code theme',
      importHint:
        "Paste a theme's .json or drop the file here. Only its colours are kept; text is adjusted where needed so it stays readable.",
      importLabel: 'Theme file contents',
      importPlaceholder:
        '{ "name": "My theme", "type": "dark", "colors": { "editor.background": "#1e1e2e" } }',
      chooseFile: 'Choose file…',
      check: 'Preview',
      add: 'Add and use',
      cancel: 'Cancel',
      dropped: (n: number) =>
        `${n} ${n === 1 ? 'value was' : 'values were'} not ${n === 1 ? 'a colour' : 'colours'} and ${n === 1 ? 'was' : 'were'} left out.`,
      ready: (name: string) => `${name} is ready. Try it here, then add it.`,
      remove: (name: string) => `Delete ${name}`,
      removeConfirm: 'Delete?',
      importedName: 'Imported theme',
      noImported: 'Themes you import show here.',
      full: (n: number) => `You can keep ${n} imported themes; delete one to add another.`,
      importErrors: {
        empty: "Paste a theme's .json first, or drop the file here.",
        tooBig: 'This file is too large for a colour theme.',
        notJson: "This isn't valid JSON. Copy the whole theme file, including its first { and last }.",
        notTheme: "This JSON isn't a VS Code colour theme: it has no colors section.",
        include:
          'This theme builds on another file (its "include"), which can\'t be followed from here. Paste the theme it includes, or a complete one.',
        noBackground:
          'This theme has no editor.background colour, so there is nothing to build the look from.',
        unreadable: "This file couldn't be read.",
      },
    },
    models: {
      title: 'Models',
      intro: (count: number, shown: number) =>
        `${count} models you can call right now, ${shown} shown in pickers. Switch off whole providers you don’t use, remove single models, and test any model with a one-line request.`,
      search: 'Search models',
      refreshed: 'Model lists refreshed from providers',
      refresh: 'Refresh',
      addModels: 'Add models',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      noMatch: 'No models match',
      none: 'No models yet',
      inPickers: 'In pickers',
      showProvider: (provider: string) => `Show ${provider} models in pickers`,
      testMs: (ms?: number) => `${ms} ms`,
      testFailed: 'failed',
      respondedIn: (time: string) => `Responded in ${time}`,
      test: 'Test',
      remove: (name: string) => `Remove ${name}`,
      removeHideTitle: 'Remove from pickers; Hidden models below brings it back',
      removeDeleteTitle: (provider: string) => `Remove from ${provider}’s model list`,
      confirmRemove: 'Yes, remove model',
      /** Who uses a model by default, as `inUse` lists them. */
      users: { lead: 'lead', crewmates: 'crewmates', reviewer: 'reviewer', call: 'call assistant' },
      inUse: (who: string, many: boolean) =>
        `Your ${who} ${many ? 'use' : 'uses'} it, and will switch to another model.`,
      removedHidden: (name: string) => `Removed ${name} from pickers.`,
      removedDeleted: (name: string, provider: string) => `Removed ${name} from ${provider}.`,
      /** After a removal: who uses which model now. */
      nowLeads: (model: string) => `New chats now lead with ${model}.`,
      nowNames: (model: string) => `${model} names chats now.`,
      hiddenHeading: (n: number) => `Hidden models · ${n}`,
      /** Hidden models as search names them. */
      hiddenTitle: 'Hidden models',
      restore: 'Restore',
      restoreLabel: (name: string) => `Restore ${name}`,
      windowSources: {
        set: 'set by you',
        provider: 'from the provider',
        catalog: 'from a public model catalog',
        name: "from the model's name",
      },
      windowPlaceholder: 'e.g. 32k',
      windowLabel: (model: string) => `Context window of ${model}`,
      windowGuess: 'a guess',
      windowTitle: (tokens: string, source: string) =>
        `${tokens} tokens of context, ${source}. Click to change; clear it to go back to automatic.`,
      windowUnknown: 'Context window unknown. Click to set it.',
    },
    signIns: {
      signedInToast: (who?: string) => `Signed in${who ? ` as ${who}` : ''}`,
      failed: 'Sign-in failed',
      title: 'Sign in with a subscription',
      subtitle: 'use Claude, ChatGPT or Gemini plans instead of API keys',
      signedIn: 'signed in',
      signInAgain: 'Sign in again',
      signIn: 'Sign in',
      signOut: 'Sign out',
      confirmSignOut: (name: string) => `Yes, sign out of ${name}`,
      signedOut: (name: string) => `Signed out of ${name}`,
      finishInBrowser: 'Finish signing in in the browser tab; this updates by itself.',
      openPage: 'Open the sign-in page',
      submit: 'Finish sign-in',
      showMore: (n: number) => `Show ${n} more sign-ins`,
    },
    providers: {
      title: 'Providers & keys',
      intro:
        'Connect the AI services your agents use: sign in with a subscription, add an API key, or point Myrmidon at your own endpoint. Keys are kept on the computer Myrmidon runs on, readable only by your account, and never sent back to the browser.',
      storedIn: (dir: string) => `Stored in ${dir}`,
      importTitle: 'Import keys from oh-my-pi (omp)',
      importConfirm:
        'Replaces Myrmidon’s keys, sign-ins, and custom providers with oh-my-pi’s, from ~/.omp/agent.',
      importHint:
        'oh-my-pi is the agent toolkit Myrmidon builds on. This copies its keys, sign-ins, and custom providers from ~/.omp/agent; it need not be installed.',
      imported: 'Imported your keys from oh-my-pi',
      replaceAndImport: 'Replace and import',
      import: 'Import',
      heading: 'Providers',
      readyCount: (ready: number, total: number) => `${ready} ready of ${total}`,
      customEndpoint: 'Custom endpoint',
      connected: (name: string) => `Connected ${name}`,
      emptyTitle: 'No providers ready yet',
      emptyBody:
        'Import keys from oh-my-pi (omp), add a key below, or connect LM Studio, Ollama, vLLM, OpenRouter, or any OpenAI, Anthropic, or Gemini-compatible endpoint.',
      custom: 'custom',
      modelCount: (n: number) => `${n} model${n === 1 ? '' : 's'}`,
      edit: 'Edit',
      replaceKey: 'Replace key',
      addKey: 'Add key',
      externalCredentials:
        'Its credentials come from outside Myrmidon (environment variables, a cloud profile such as ~/.aws, or none needed). Turn it off to stop using its models.',
      use: (id: string) => `Use ${id}`,
      removeCredentials: (id: string) => `Remove ${id} credentials`,
      confirmRemoveCredentials: 'Yes, remove credentials',
      removedCredentials: (id: string) => `Removed ${id} credentials`,
      remove: (id: string) => `Remove ${id}`,
      confirmRemove: 'Yes, remove provider',
      removed: (id: string) => `Removed ${id}`,
      updated: (id: string) => `Updated ${id}`,
      savedKey: (id: string) => `Saved the ${id} key`,
      showMore: (n: number) => `Show ${n} more built-in providers`,
      /** Text around the ANTHROPIC_API_KEY example. */
      envBefore: 'Environment variables such as ',
      envAfter: ' also work.',
      apiKeyFor: (provider: string) => `${provider} API key`,
    },
    providerForm: {
      apiLabels: {
        'openai-completions': 'OpenAI-compatible (chat completions)',
        'openai-responses': 'OpenAI Responses API',
        'anthropic-messages': 'Anthropic Messages API',
        'google-generative-ai': 'Google Gemini API',
      },
      name: 'Name',
      nameFixed: 'The model prefix; fixed once created.',
      nameHint: 'Lowercase. Becomes the model prefix, e.g. lmstudio/qwen3',
      apiType: 'API type',
      baseUrl: 'Base URL',
      authentication: 'Authentication',
      apiKey: 'API key',
      keyless: 'None (local)',
      keySaved: 'Key saved · type to replace',
      models: 'Models',
      modelsDiscoverHint:
        'Model ids, separated by commas. Leave empty to discover them from the endpoint’s model list.',
      modelsHint: 'Model ids, separated by commas.',
      modelIds: 'Model ids',
      saveChanges: 'Save changes',
      connect: 'Connect',
      /** Appended to the Connect / Save changes button. */
      modelCount: (n: number) => ` · ${n} model${n === 1 ? '' : 's'}`,
    },
    team: {
      title: 'Crew & budget',
      intro: 'Defaults for every new chat. You can still change the crew per message.',
      timeLimit: 'Time limit per run',
      timeLimitHint: 'The crew stops when this runs out, reviewed or not.',
      spendLimit: 'Spend limit per run',
      /** The default is the runtime's DEFAULT_COST_USD. */
      spendLimitHint:
        'The run stops at this cost; at 80% agents are told to wrap up. Each follow-up gets the full limit again. Starts at $5; 0 means no limit.',
      tokenLimit: 'Token limit per run',
      tokenLimitHint: 'Counts every token the models process, cached input included. 0 means no limit.',
      turns: 'Turns per agent',
      turnsHint: 'Each agent stops after this many turns.',
      observer: 'Check-in interval',
      observerHint: 'How often Myrmidon checks for stuck or idle agents and for time running out.',
      units: { minutes: 'min', dollars: '$', tokens: 'tok', seconds: 's' },
      crewTitle: 'Default crew',
      limitsTitle: 'Limits per run',
    },
    tools: {
      title: 'Tools',
      intro: 'Tool connectors (MCP servers), the tools agents made that you kept, and web search.',
      /** Folders sandboxed agents may read beyond the defaults, in every chat. */
      reads: {
        title: 'Folders agents may also read',
        subtitle: 'read only, in every chat; projects add their own',
        home: 'Everything in my home (read-only)',
        homeHint:
          'Agents may read any file in your home. Your keys, sign-ins and other chats stay hidden unless you name them below.',
        folders: 'Folders agents may read, one per line, starting with ~ or /',
        foldersPlaceholder: '~/Documents/notes\n~/code/shared-libs',
        guarded: (paths: readonly string[]) =>
          `Careful: ${paths.join(', ')} ${paths.length === 1 ? 'holds' : 'hold'} keys, sign-ins or every chat’s data. Agents in all your chats can read ${paths.length === 1 ? 'it' : 'them'}, and anything they read can leave over the network.`,
      },
      libraryTitle: 'Your tool library',
      librarySubtitle: 'tools agents made that you kept; every new run starts with them',
      webSearch: 'Web search',
      searchProvider: 'Search provider',
      searchProviderHint:
        'Auto tries the search providers you have keys for first, then keyless ones like DuckDuckGo.',
      searchAuto: 'Auto',
    },
    mcp: {
      added: (name: string) => `Added ${name}`,
      reconnected: 'Reconnected MCP servers',
      title: 'MCP servers (tool connectors)',
      subtitle: 'from mcp.json, including any imported from oh-my-pi',
      reconnect: 'Reconnect',
      addServer: 'Add server',
      name: 'Name',
      transport: 'Transport',
      transportStdio: 'Local command (stdio)',
      transportHttp: 'Remote (HTTP)',
      transportSse: 'Remote (SSE, legacy)',
      command: 'Command',
      commandHint: 'The program and its arguments.',
      environment: 'Environment',
      environmentHint: 'KEY=value per line. Your own API keys are not passed on otherwise.',
      url: 'URL',
      addAndConnect: 'Add and connect',
      empty: 'No MCP servers yet. Add one, or import them from oh-my-pi under Models & providers.',
      statuses: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        disabled: 'disabled',
        error: 'error',
      },
      toolCount: (n: number) => `${n} tools`,
      enable: (name: string) => `Enable ${name}`,
      enabled: (name: string) => `Enabled ${name}`,
      disabled: (name: string) => `Disabled ${name}`,
      remove: (name: string) => `Remove ${name}`,
      confirmRemove: 'Yes, remove server',
      removed: (name: string) => `Removed ${name}`,
    },
    channels: {
      title: 'Channels',
      intro:
        "Talk to your crew from the messaging services you already use. A channel continues the same chats as this window: you'll see them in the sidebar, and either can carry on.",
      secretSet: 'Saved; type a new one to replace it',
      turnOn: 'Turn on',
      yours: 'Your channels',
      search: 'Search channels…',
      noMatch: 'No channel matches that.',
      loadError: (error: string) => `Channels could not be loaded: ${error}`,
      groupsTitle: { messengers: 'Messengers', work: 'Work chat', other: 'Other' },
      waitingBadge: (n: number) => `${n} waiting`,
      tabs: { setup: 'Setup', people: 'People', rules: 'Rules', activity: 'Activity' },
      health: {
        lastIn: (when: string) => `Last message ${when}`,
        lastOut: (when: string) => `Last answer ${when}`,
        never: 'nothing yet',
        reconnects: (n: number) => (n === 1 ? 'Reconnected once' : `Reconnected ${n} times`),
        lastError: (error: string) => `Last error: ${error}`,
        owed: (n: number) =>
          n === 1 ? '1 answer waiting to be resent' : `${n} answers waiting to be resent`,
      },
      noActivity: 'Nothing has happened on this channel yet. Messages and answers show here.',
      remove: 'Remove channel',
      removeConfirm: 'Yes, remove channel',
      removeWarning:
        'Disconnects it and forgets its token, approved people and groups, and any linked device. Chats it started stay.',
      removed: (label: string) => `Removed ${label}`,
      add: 'Add a channel',
      addHint:
        'Pick a channel to set it up. Each one runs through the same access rules, approvals and delivery.',
      save: 'Save',
      saving: 'Checking…',
      optional: (label: string) => `${label} (optional)`,
      stillNeeded: (labels: string[]) => `Still needed: ${labels.join(', ')}`,
      saved: (account: string) => `Connected as ${account}`,
      on: 'On',
      project: 'Project for new chats',
      projectHint: 'Where work started from this channel happens; none keeps it out of your folders.',
      noProject: 'None',
      status: {
        off: 'Off',
        setUpOff: 'Set up · off',
        notSetUp: 'Setup not finished',
        connecting: 'Connecting…',
        on: (account: string) => `Connected as ${account}`,
        retrying: (error: string) => `Reconnecting: ${error}`,
        error: (error: string) => error,
        linking: 'Scan this code with your phone to link it',
      },
      waiting: 'Waiting for approval',
      waitingHint:
        'People and groups who messaged your bot. To approve one, type the code the bot sent them: only they, or someone they told, can know it.',
      ownerFirst:
        'No owner yet: the first person you approve becomes the owner, who approves risky steps and can allow tools for good. Approve yourself first, with the code your own message got.',
      group: (title: string) => `group “${title}”`,
      sender: (platform: string, id: string, handle?: string) =>
        `${handle ? `@${handle} · ` : ''}${platform} ID ${id}`,
      expires: (when: string) => `expires ${when}`,
      code: 'Code they were sent',
      approve: 'Approve',
      makeOwner: 'Make owner',
      makeOwnerName: (name: string) => `Make ${name} the owner`,
      makeOwnerConfirm: 'Yes, make owner',
      makeOwnerWarning:
        'They approve risky steps and can allow tools for good; the current owner becomes a member.',
      makeOwnerFirstWarning: 'They approve risky steps and can allow tools for good.',
      madeOwner: (name: string) => `${name} is now the owner`,
      confirmOwner: (name: string) =>
        `${name} is the owner, but may have become it just by being under "Let in without a code", which no longer gives ownership. Confirm them if they are you or someone you trust; otherwise make someone else the owner or revoke them.`,
      confirmOwnerButton: 'Confirm owner',
      ownerConfirmed: (name: string) => `Confirmed ${name} as the owner`,
      decline: 'Decline',
      declineName: (name: string) => `Decline ${name}`,
      declineConfirm: 'Yes, decline request',
      people: 'Approved people',
      groups: 'Approved groups',
      owner: 'Owner',
      member: 'Member',
      revoke: 'Revoke',
      revokeName: (name: string) => `Revoke ${name}`,
      revokeConfirm: 'Yes, revoke access',
      revokeWarning: 'Their messages are ignored until they are approved again with a new code.',
      revokeOwnerWarning:
        'This channel will have no owner: nothing can be approved in the chat until you approve someone with a new code or make a member the owner.',
      revokeGroupWarning: 'The bot ignores the group until it is approved again with a new code.',
      none: 'No one yet: message your bot to get a code.',
      approved: (name: string) => `Approved ${name}`,
      dm: 'Direct messages',
      dmHint: {
        pairing:
          'Strangers get a code; nothing they write is acted on until you approve it. Runs anyone but the owner starts ask the owner before every step that changes something or reads the project; they can still search the web and get answers.',
        allowlist:
          'Only approved people and the list below; everyone else is ignored without a reply. Runs anyone but the owner starts ask the owner before every step that changes something or reads the project; they can still search the web and get answers.',
        open: 'Anyone who finds the bot can use your crew, at your cost. Their runs ask the owner before every step that changes something or reads the project, even tools you always allow; they can still search the web. Only for a bot no one else knows.',
        disabled: 'The bot answers no direct messages.',
      },
      dmOptions: {
        pairing: 'Approve with a code',
        allowlist: 'Listed people only',
        open: 'Anyone',
        disabled: 'Off',
      },
      groupsLabel: 'Groups',
      groupsHint: {
        approve: 'Each group is approved once; the bot answers only approved people there.',
        open: 'Any group the bot is added to, for approved people.',
        disabled: 'The bot answers no groups.',
      },
      groupsOptions: { approve: 'Approve each group', open: 'Any group', disabled: 'Off' },
      mention: 'Only when mentioned in groups',
      mentionHint: 'Answer in a group only when someone @mentions or replies to the bot.',
      perPerson: 'A chat per person in groups',
      perPersonHint:
        'Each person in a group gets their own chat with the crew, instead of one for the group.',
      allow: 'Let in without a code',
      allowHint:
        'IDs or @usernames, separated by commas. They come in as members; make someone the owner under People.',
      allowPlaceholder: '@alice, 123456789',
      allowSaved: 'Saved.',
      allowStale: (entries: string[], example?: string) =>
        `${entries.join(', ')} never ${entries.length === 1 ? 'matches' : 'match'} anyone here: ${example ? `write it like ${example}, or remove it` : 'remove it, or separate entries with commas'}.`,
      stream: 'While the crew works',
      streamHint: {
        progress: 'One message that updates with what each agent is doing, then the answer as a new message.',
        partial: 'The answer appears as it is written, in one message.',
        final: 'Only a typing indicator, then the answer.',
      },
      streamOptions: { progress: 'Status line', partial: 'Live answer', final: 'Just the answer' },
    },
    voice: {
      title: 'Voice',
      intro:
        'Call your crew from the chat. The call assistant talks with you on a fast model, hands real work to the crew as a run, and tells you when it is done. Your voice becomes text, and replies become speech, on this Mac or through a voice provider you set up in Models & providers; or one realtime model does all of it.',
      enabled: 'Voice calls',
      /** Sizes are written like "1.3 MB", or empty when the server does not say. */
      enabledHint: (sizes: { detector: string; turn: string; kitten: string }) =>
        `Off by default. Turning them on downloads, once, what is not here yet: the speech detector${sizes.detector && ` (${sizes.detector})`}, the turn model${sizes.turn && ` (${sizes.turn})`} and, for Kitten TTS, its model${sizes.kitten && ` (${sizes.kitten})`}. Phonon-2 is not installed for you: press Install below, and its model downloads the first time it starts. Voice providers download nothing. All are kept ready, so a call answers at once.`,
      transcripts: (days: number) =>
        `Call transcripts are kept with their chat for ${days} days, then deleted.`,
      callModel: 'Call assistant model',
      callModelHint: 'A fast model suits a call best: the assistant only talks and hands work to the crew.',
      sameAsLead: 'Same as the lead',
      ownModel: 'Its own model',
      leadModel: (model: string) => `Uses ${model}.`,
      sttTitle: 'Speech to text',
      ttsTitle: 'Text to speech',
      engineLabel: 'Engine',
      mode: 'Call mode',
      modes: { pipeline: 'Pipeline', realtime: 'Realtime' },
      modeHints: {
        pipeline:
          'Your words become text, the call assistant answers on its model, and its answer is spoken: each part is yours to choose below.',
        realtime:
          'One realtime model hears you, answers and speaks, so it replies sooner. It has the same tools: it hands work to the crew and puts approvals to you. Calls straight to the lead or a crew member still use speech to text and text to speech below.',
      },
      realtimeTitle: 'Realtime model',
      realtimeProvider: 'Provider',
      realtimeModel: 'Model',
      realtimeVoice: 'Voice',
      noRealtime: 'No realtime model is set up yet: add an OpenAI or Gemini key under Voice providers.',
      directOnly: 'Used for calls straight to the lead or a crew member.',
      /** The groups of the speech engine pickers. */
      groups: {
        local: 'On this computer',
        omp: 'Your model providers’ speech models',
        cloud: 'Voice providers',
        missing: 'Voice providers without a key',
        yours: 'Your own services',
      },
      needsKey: (provider: string) => `${provider} (needs a key)`,
      needsRegion: (provider: string) => `${provider} (needs a region)`,
      addProvider: 'Add a voice provider',
      addProviderHint:
        'Voice providers and their keys are set up in Models & providers, with your model providers.',
      cloudHints: {
        streams: (provider: string) =>
          `${provider} hears you as you speak, so your words show while you talk; your audio is sent to ${provider}.`,
        batch: (provider: string) => `Each turn is sent to ${provider} once you finish speaking.`,
        speaks: (provider: string) =>
          `What the call says is sent to ${provider}, and its voice plays as it is made.`,
        speaksWhole: (provider: string) => `What the call says is sent to ${provider}, a sentence at a time.`,
        endpoint: (address: string) => `Sent to ${address}.`,
        fallback: 'If it fails mid-call, the call switches to the engine on this computer, when it is here.',
      },
      voicesLoading: 'Loading voices…',
      endpointModel: 'Model',
      endpointVoice: 'Voice',
      providers: {
        phonon: 'On-device speech recognition (Phonon-2)',
        omp: 'Cloud (your signed-in providers)',
        kitten: 'On-device voices (Kitten TTS)',
      },
      hints: {
        phonon: (size: string) =>
          `Fermion Research’s English model${size && ` (${size})`}, with a Python runtime installed by uv. Your voice is transcribed on this Mac; the text goes to your call model like any message.`,
        ompStt: (models: string) =>
          models
            ? `Uses ${models}: your audio is sent to that provider to be transcribed.`
            : 'Needs an OpenAI or Groq key in Settings → Models; your audio would be sent to that provider.',
        ompTts: (models: string) =>
          models
            ? `Uses ${models}: what the call says is sent to that provider to be spoken.`
            : 'Needs an OpenAI or xAI key in Settings → Models; what the call says would be sent to that provider.',
        plainHttp:
          'This address is plain http: your audio and the API key travel unencrypted. Use https unless the service runs on the same computer as Myrmidon.',
        kitten: 'KittenML’s small voices, run locally on the CPU; nothing is sent anywhere.',
      },
      engine: {
        missing: 'Not installed',
        installing: 'Installing…',
        ready: 'Installed',
        starting: 'Starting… the first time, the model above downloads: allow a few minutes',
        running: 'Running',
        downloading: (done: number, total: number) => `Downloading (${done}/${total})…`,
        downloadingBytes: (received: string, size: string) => `Downloading ${received} of ${size}…`,
      },
      /** An engine that failed, in plain words: what went wrong and what to do; the raw message is behind details. */
      trouble: {
        noUv: {
          cause: 'Phonon-2 needs uv, the Python installer, and it is not on this Mac.',
          fix: 'Install uv from docs.astral.sh/uv, then press Install again.',
        },
        phonon: {
          cause: 'Phonon-2 could not install or start.',
          fix: 'Check the internet connection and press Reinstall, or pick Cloud for speech to text.',
        },
        kitten: {
          cause: 'The Kitten TTS model could not download.',
          fix: 'Check the internet connection and press Download again, or pick Cloud for text to speech.',
        },
        details: 'Show details',
      },
      install: 'Install',
      reinstall: 'Reinstall',
      download: 'Download',
      model: 'Model',
      kittenModel: 'Model size',
      kittenModels: {
        nano: 'Nano (fastest)',
        micro: 'Micro',
        mini: 'Mini (best sounding)',
      },
      voice: 'Voice',
      speed: 'Speed',
      tryIt: 'Try it',
      trySentence: 'Hi, this is your crew. What should we work on?',
      sensitivity: 'Speech sensitivity',
      sensitivityHint:
        'Lower it if background noise interrupts the call; raise it if quiet speech is missed.',
      sensitivities: { low: 'Low', normal: 'Normal', high: 'High' },
      phone: {
        title: 'Phone calls',
        enabled: 'Answer calls to the SMS number',
        hint: 'Calls to the Twilio number set up under Settings → Channels → SMS reach the call assistant, from the people SMS lets in; other numbers are turned away unanswered (or texted a code, if SMS sends strangers one). Turning this on points the number’s voice webhook at this Myrmidon, which needs a public https address. Twilio charges for each call minute.',
        connecting: 'Connecting to Twilio…',
        on: (number: string) => `Answering calls to ${number}.`,
        callMe: 'Call my phone',
        callMeHint:
          'The Twilio number calls the SMS owner, who talks with the call assistant as on any call.',
        calling: (to: string) => `Calling ${to}…`,
      },
    },
    /** Settings → Models & providers → Providers: the voice providers part. */
    voiceProviders: {
      heading: 'Voice providers',
      intro:
        'Speech to text, voices and realtime models for calls. Keys are kept in the same place as your model providers’ keys; where a voice provider is also a model provider (OpenAI, Gemini, Groq), the key you added for its models is used.',
      tags: { stt: 'Speech to text', tts: 'Voice', realtime: 'Realtime' },
      streams: 'streams',
      key: {
        stored: 'Key saved',
        shared: (provider: string) => `Uses your ${provider} key`,
        env: 'Key from the environment',
        missing: 'No key yet',
      },
      addKey: 'Add key',
      replaceKey: 'Replace key',
      sharedKeyHint: (provider: string) =>
        `This is the ${provider} model provider’s key too: add or replace it here, remove it under the model providers above.`,
      remove: (provider: string) => `Remove ${provider}'s key`,
      confirmRemove: 'Yes, remove key',
      savedKey: (provider: string) => `Saved ${provider}'s key`,
      removedKey: (provider: string) => `Removed ${provider}'s key`,
      getKey: 'Get a key',
      apiKey: 'API key',
      accessKeyId: 'Access key ID',
      secretAccessKey: 'Secret access key',
      region: 'Region',
      regionHint: 'Where your resource is, such as westeurope or us-east-1.',
      regionSaved: (provider: string) => `Saved ${provider}'s region`,
      endpoints: {
        heading: 'Your own speech services',
        note: 'Any service with the OpenAI audio API: a local whisper, Kokoro or Piper server, and others.',
        add: 'Add a speech service',
        name: 'Name',
        nameHint: 'Lowercase, like kokoro; it is how Settings → Voice lists it.',
        baseUrl: 'Address',
        key: 'API key (if it needs one)',
        connect: 'Add',
        added: (name: string) => `Added ${name}`,
        remove: (name: string) => `Remove ${name}`,
        confirmRemove: 'Yes, remove service',
        removed: (name: string) => `Removed ${name}`,
        noKey: 'no key',
      },
    },
    gateways: {
      title: 'Gateways',
      intro:
        'Other Myrmidons, like one on a VPS, to switch to at the top of the sidebar; each keeps its own chats and settings. Their access stays here, never in the page.',
      add: 'Add a gateway',
      link: 'Pairing link',
      linkHint: 'Run `myrmidon pair` on the gateway (or use its Settings → Devices) and paste the link here.',
      name: 'Name',
      nameHint: 'How it shows in the sidebar; the first part of its address if left empty.',
      adding: 'Pairing…',
      added: (name: string) => `Added ${name}`,
      remove: 'Remove',
      confirmRemove: 'Yes, remove gateway',
      removed: (name: string) => `Removed ${name}; this Myrmidon is no longer paired with it.`,
      show: 'Switch to this gateway',
      shown: 'Shown here',
      empty: 'No other gateways yet. Add one above with a pairing link from it.',
      reachable: 'Reachable',
      checked: (when: string) => `checked ${when}`,
    },
    devices: {
      title: 'Devices',
      introRemote:
        'This Myrmidon is reachable from other devices. Each device that uses it was paired once and has its own access, which you can revoke here at any time.',
      introLocal:
        'This Myrmidon only answers on this computer. To use it from a phone or another computer, make it reachable from them (see docs/remote.md), then pair devices here.',
      pair: 'Pair a device',
      pairNeedsRemoteTitle: 'Pairing needs Myrmidon to be reachable',
      pairNeedsRemote:
        'A pairing link made now would open only on this computer, so there is nothing to pair yet.',
      scope: 'Access',
      /** Short, for the toggle. */
      scopes: { full: 'Full', chat: 'Chats' },
      /** In the list of devices. */
      scopeNames: { full: 'Full access', chat: 'Chats only' },
      scopeHints: {
        full: 'Everything, including the terminal, keys, Settings and devices.',
        chat: 'Chats, files and approvals; not the terminal, keys, Settings, plugins or devices.',
      },
      link: 'Open this link on the device (one use, 10 minutes):',
      code: (code: string) => `or enter the code ${code}`,
      copy: 'Copy link',
      copied: 'Copied',
      empty: 'No devices paired yet. Pair one to use this Myrmidon from a phone or another computer.',
      thisDevice: 'this device',
      viaHub: 'through another Myrmidon',
      lastSeen: (when: string) => `last seen ${when}`,
      never: 'not seen yet',
      revoke: 'Revoke',
      confirmRevoke: 'Yes, revoke access',
      confirmRevokeSelf: 'Yes, revoke and lose access',
      revokeSelfWarning: 'This is the device you are using now: it loses access as soon as you revoke it.',
      revoked: (name: string) => `${name} can no longer use this Myrmidon`,
    },
    specialists: {
      title: 'Specialists',
      intro:
        'Crewmates you define once and bring back. Each joins under its own name, works the way you describe, on its own model, with only the tools you allow. Add one to a crew from the composer, or the lead brings it in when the work fits it.',
      empty: 'No specialists yet.',
      emptyHint: 'Create one here, or save a crewmate that did well from its sheet in a chat.',
      add: 'New specialist',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Yes, delete specialist',
      removed: (name: string) => `Deleted ${name}`,
      modelHint: "Leave it unset to use the crew's model for crewmates.",
      useTeamModel: "Use the crew's model",
      saved: (name: string) => `Saved ${name}`,
      name: 'Name',
      nameHint: 'Lowercase, like ada or scout. You can write to it as @name.',
      specialty: 'Specialty',
      specialtyHint: 'What it is for, in a few words: data analyst, UI copywriter.',
      instructions: 'How it works',
      instructionsHint: 'Its own instructions: approach, standards, what to always or never do.',
      model: 'Model',
      teamModel: "The crew's model for crewmates",
      tools: 'May use',
      groups: { web: 'Web', shell: 'Shell', files: 'Files', browser: 'Browser', mcp: 'MCP servers' },
      save: 'Save',
      cancel: 'Cancel',
      toolsOff: (groups: string) => `no ${groups}`,
      saveFromChat: 'Save as specialist',
      saveFromChatTitle: (name: string) => `Keep ${name} as a specialist`,
    },
    mascot: {
      title: 'You & your mascot',
      intro: 'What the mascot calls you, who writes the line it greets you with, and how it looks.',
      name: 'Your name',
      nameHint: (account: string) => `Leave empty to use your computer account's name (${account}).`,
      greeting: 'Greeting',
      greetingHints: {
        model:
          'A small, fast model you have (the one that names chats) writes it from what happened while you were away. A few hundred tokens when there is news.',
        rules: 'Written by Myrmidon itself, from the same facts. No model calls.',
      },
      greetingModel: 'Model',
      greetingRules: 'Built in',
      titles: 'Chat names',
      titlesHints: {
        model:
          'A small, fast model you have names each chat from what it is about after a run (a chat that is only "hi" so far waits). Names you give are kept.',
        'first-message': 'Chats are named with their first message. No model calls.',
      },
      titlesModel: 'From the topic',
      titlesFirst: 'First message',
      eyes: 'Eyes',
      eyeStyles: { round: 'Round', happy: 'Happy', tall: 'Tall', sleepy: 'Sleepy', lashes: 'Lashes' },
      look: 'Look',
      looks: { neutral: 'Neutral', flower: 'Flower', bow: 'Bow tie' },
      color: 'Colour',
      colors: { amber: 'Amber', ice: 'Ice', mint: 'Mint', pink: 'Pink', violet: 'Violet', white: 'White' },
      screen: 'The screen shows',
      screens: {
        rotate: 'All in turn',
        clock: 'Clock',
        name: 'Your name',
        crew: 'Crew at work',
        face: 'Nothing',
      },
      livePreview: 'Live preview of the mascot',
      liveliness: 'Liveliness',
      livelinessHint: 'How much it gets up to on its own on the new-chat view.',
      idle: 'Tricks while left alone',
      idleLevels: { off: 'Off', rare: 'Rarely', normal: 'Sometimes', often: 'Often' },
      shows: 'Shows it may play',
      showNames: { pacman: 'Pac-Man', life: 'Game of Life', confetti: 'Confetti', boot: 'Boot sweep' },
      showHints: {
        pacman: 'Now and then one eye eats a row of dots.',
        life: 'Its screensaver after a long nap.',
        confetti: 'When a run finishes.',
        boot: 'A scanline as the screen switches on.',
      },
      temper: 'Temperament',
      tempers: { calm: 'Calm', playful: 'Playful' },
      temperHints: {
        calm: 'No bouncing, dizzy spells or knocked-over crew; only quiet eye tricks.',
        playful: 'Bounces when poked, gets dizzy when shaken, sneezes and plays games.',
      },
      crew: 'Crew cursors',
      crewHint: 'The little cursors that wander around it and poke it, in windows wide enough for them.',
      crewShow: 'Show crew cursors',
      crewCount: 'How many',
      crewNames: 'Names',
      crewSources: { minions: 'Minions', specialists: 'Your specialists', custom: 'Your own' },
      crewSourceHints: {
        minions: 'Kevin, Stuart, Bob and friends.',
        specialists: (n: number) =>
          n === 0
            ? 'You have no specialists yet, so Minions stand in.'
            : `Named after your ${n} specialist${n === 1 ? '' : 's'}; Minions fill any spare places.`,
        custom: 'Up to 8 names, separated by commas; Minions fill any spare places.',
      },
      crewCustom: 'Your names',
      crewCustomPlaceholder: 'Ada, Grace, Linus',
      boldness: 'Boldness',
      boldnessLevels: { shy: 'Shy', curious: 'Curious', bold: 'Bold' },
      boldnessHints: {
        shy: 'Keep their distance, rarely poke it, and scatter at the slightest start.',
        curious: 'A mix: some poke often, some hang back.',
        bold: 'Poke it all the time and stand their ground.',
      },
      display: 'Screen look',
      displayHint: 'How its dot screen is drawn.',
      dots: 'Dots',
      dotShapes: { led: 'LED', round: 'Round', square: 'Square' },
      grid: 'Unlit dots',
      grids: { faint: 'Faint', tinted: 'Tinted', off: 'Hidden' },
      glow: 'Glow',
      glows: { off: 'Off', soft: 'Soft', strong: 'Strong' },
      eyeColor: 'Eye colour',
      eyeColors: { own: 'Its own', theme: "Theme's accent" },
      eyeColorHints: {
        own: 'The colour chosen above, whatever the theme.',
        theme: 'Follows the accent of the theme in Appearance; moods still bring their own colours.',
      },
      size: 'Size',
      sizes: { small: 'Small', medium: 'Medium', large: 'Large' },
      sounds: 'Sounds',
      soundsHint: 'Soft blips made on the fly in this window. Off unless you turn them on.',
      soundsOn: 'Play sounds',
      soundReactions: 'When it reacts',
      soundTyping: 'While you type',
      volume: 'Volume',
      volumes: { quiet: 'Quiet', normal: 'Normal', loud: 'Louder' },
      testSound: 'Play a blip',
    },
    reviewer: {
      hints: {
        off: "Never. The lead's final answer completes the run.",
        auto: 'When the lead decides the work deserves it: code, files, research with sources.',
        always: 'Every final answer, before the run completes; findings go back to the lead to fix.',
      },
      title: 'Reviewer',
      intro:
        'An independent model checks the work against your request. Choose its model under Default crew above; one from another provider than the crew catches more.',
      when: 'When to review',
      auto: 'Auto',
      always: 'Always',
      threshold: 'Pass threshold',
      thresholdHint: 'Reviewer score from 0 to 1 needed for the work to pass.',
      rubric: 'Custom rubric',
      rubricHint: 'Optional. Replaces the default rubric the reviewer scores against.',
      rubricPlaceholder:
        'e.g. Code must include tests that pass; reports must cite a primary source for every number.',
    },
    instructions: {
      title: 'Agent instructions',
      intro: 'Added to the system prompt of every agent in new chats. Use it for your house rules.',
      lead: 'Lead',
      leadHint: 'Planning, delegation, and how to talk to you.',
      leadPlaceholder: 'e.g. Prefer TypeScript. Keep plans to three bullets. Always cite sources.',
      workers: 'Crewmates',
      workersHint: 'How crewmates should do and report their part.',
      workersPlaceholder: 'e.g. Write tests first. Report blockers immediately.',
    },
    schedules: {
      repeat: {
        label: 'Repeat',
        hourly: 'Every hour',
        daily: 'Every day',
        weekdays: 'Weekdays',
        weekly: 'On chosen days',
        monthly: 'Monthly',
        custom: 'Custom (cron)',
      },
      time: 'Time',
      minutePast: 'Minutes past the hour',
      dayOfMonth: 'Day of the month',
      days: 'Days',
      /** Sunday first, as cron counts them (0 = Sunday). */
      dayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      dayPlural: ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'],
      /** "A, B and C". */
      list: (items: readonly string[]) =>
        items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`,
      ordinal: (n: number) => {
        const tens = n % 100
        const suffix =
          tens >= 11 && tens <= 13
            ? 'th'
            : n % 10 === 1
              ? 'st'
              : n % 10 === 2
                ? 'nd'
                : n % 10 === 3
                  ? 'rd'
                  : 'th'
        return `${n}${suffix}`
      },
      describe: {
        hourly: (minute: string) => `Every hour at :${minute}`,
        daily: (time: string) => `Every day at ${time}`,
        weekdays: (time: string) => `Weekdays at ${time}`,
        days: (days: string, time: string) => `${days} at ${time}`,
        monthly: (day: string, time: string) => `Monthly on the ${day} at ${time}`,
        custom: (cron: string) => `Custom: ${cron}`,
      },
      localTime: 'in this computer’s time zone',
      pickADay: 'Pick at least one day',
      shortMonths: (day: string) => `Months without a ${day} are skipped`,
      change: 'Change',
      save: 'Save',
      cancel: 'Cancel',
      updated: 'Schedule updated',
      title: 'Schedules',
      intro:
        'Requests that run by themselves, each in a new chat with your default crew and reviewer. Myrmidon must be running. Turn on notifications in General to hear when one ends.',
      request: 'Request',
      requestPlaceholder: 'e.g. Summarize what changed in this repo since yesterday and flag anything risky.',
      cronExpression: 'Cron expression',
      cronPlaceholder: 'e.g. 0 9 * * 1-5 (minute hour day month weekday)',
      project: 'Project',
      noProject: 'No project',
      deliver: 'Send results to',
      noDeliver: 'Only in the app',
      deliverTo: (channel: string) => `results to ${channel}`,
      scheduled: 'Scheduled',
      schedule: 'Schedule',
      /** The new-schedule form as search names it. */
      newTitle: 'Schedule a request',
      loading: 'Loading schedules…',
      emptyTitle: 'Nothing scheduled',
      emptyBody: 'Add a request above and it runs on its own at the times you pick.',
      inProject: (name: string) => `in ${name}`,
      next: (when: string) => `next ${when}`,
      paused: 'paused',
      last: (when: string) => `last ${when}`,
      started: 'Started a run',
      runNow: 'Run now',
      runOnSchedule: (name: string) => `Run ${name} on schedule`,
      delete: 'Delete schedule',
      confirmDelete: 'Yes, delete schedule',
    },
    hooks: {
      events: {
        PreToolUse: 'Before a tool',
        PostToolUse: 'After a tool',
        Stop: 'When a run ends',
      },
      saved: 'Hooks saved: they apply to every tool call from now on',
      title: 'Hooks',
      /** Intro text around the tool-name examples `fs_edit`, `shell`, `Edit|Write` and `Bash`. */
      introBeforeFsEdit:
        "Commands run before or after a tool or when a run ends, so a rule always holds. They get the event as JSON on stdin; exit code 2 before a tool blocks it; after a tool, it tells the agent. Tool names are Myrmidon's (",
      introBeforeShell: ', ',
      introBeforeEditWrite: ") or Claude Code's (",
      introBeforeBash: ', ',
      introAfterBash: ').',
      warningTitle: 'Hooks run as you, outside the sandbox',
      warning: 'A hook can read and change anything your account can. Add only commands you understand.',
      loading: 'Loading hooks…',
      empty: 'No hooks yet. A hook runs a command of yours before or after a tool, or when a run ends.',
      when: 'When',
      tools: 'Tools',
      toolsPlaceholder: 'Tools, e.g. Edit|Write (empty: all)',
      timeout: 'Timeout in seconds',
      timeoutPlaceholder: '60s',
      remove: 'Delete hook',
      command: 'Command',
      commandPlaceholder: 'e.g. jq -r .tool_input.file_path | xargs npx prettier --write',
      add: 'Add hook',
    },
    plugins: {
      title: 'Plugins',
      intro:
        'A plugin bundles skills, commands, hooks and MCP servers, on and off as one. Claude Code plugins work unchanged. It runs as you: add only plugins you trust.',
      sourcePlaceholder: 'Folder path or git URL, e.g. ~/code/my-plugin or https://github.com/you/plugin',
      sourceLabel: 'Plugin folder or git URL',
      add: 'Add plugin',
      adding: 'Adding…',
      added: (name: string) => `Added ${name}`,
      loading: 'Loading plugins…',
      emptyTitle: 'No plugins yet',
      emptyBody: 'Add one above. It can be a Claude Code plugin folder or repository.',
      canUse: (name: string) => `Use the ${name} plugin`,
      by: (author: string) => `by ${author}`,
      skills: (n: number) => `${n} skill${n === 1 ? '' : 's'}`,
      commands: (n: number) => `${n} command${n === 1 ? '' : 's'}`,
      hooks: (n: number) => `${n} hook${n === 1 ? '' : 's'}`,
      servers: (n: number) => `${n} MCP server${n === 1 ? '' : 's'}`,
      tools: (n: number) => `${n} tool${n === 1 ? '' : 's'}`,
      codeRunning: 'Its code is running',
      codeStarting: 'Its code is starting…',
      codeFailed: (error: string) => `Its code failed to load: ${error}`,
      showLog: 'Show log',
      hideLog: 'Hide log',
      secretSet: 'Set; type to replace',
      remove: 'Remove',
      confirmRemove: 'Yes, remove plugin',
      removed: (name: string) => `Removed ${name}`,
      applies:
        'Code, tools and MCP servers start now; skills, commands, hooks and prompt sections apply from the next message.',
    },
    skills: {
      sources: {
        myrmidon: 'Myrmidon',
        claude: 'Claude Code',
        plugin: 'plugin',
        project: 'project',
      },
      title: 'Skills',
      /** Intro text around the three skill folder paths. */
      introBeforeDir:
        "Playbooks in the Agent Skills format (a folder with a SKILL.md, plus scripts and references). Agents see each skill's name and description, and load the full skill when the work matches. Add one by putting its folder in ",
      introBeforeUserDir: ' or ',
      introBeforeProjectDir: "; a project's ",
      introAfterProjectDir: ' apply to its chats.',
      loading: 'Loading skills…',
      emptyTitle: 'No skills yet',
      emptyBody: 'Put a skill folder in one of the places above and it appears here.',
      /** Skills a reviewer proposed from finished work, waiting for the person. */
      proposed: (n: number) => `Proposed from your chats (${n})`,
      /** Proposed and archived skills as search names them. */
      proposedTitle: 'Proposed from your chats',
      archivedLabel: 'Archived skills',
      canUse: (name: string) => `Agents can use ${name}`,
      learned: 'learned',
      uses: (n: number, last?: string) =>
        n === 0 ? 'Not used yet' : `Used ${n === 1 ? 'once' : `${n} times`}${last ? `, last ${last}` : ''}`,
      stale: 'unused',
      staleHint: (archiveDays: number) =>
        `Not used for a while: moved to the archive after ${archiveDays} days unused, unless an agent uses it or you keep it.`,
      keep: 'Keep',
      kept: 'Kept',
      keepHint: 'Never retire this skill, however rarely it is used',
      retireIntro: (staleDays: number, archiveDays: number) =>
        `Skills Myrmidon learned are marked unused after ${staleDays} days without use and archived after ${archiveDays}; yours are never touched.`,
      archivedTitle: (n: number) => `Archived (${n})`,
      archivedHint:
        'Learned skills retired for lack of use. Agents no longer see them; restore one to bring it back.',
      restore: 'Restore',
      restored: (name: string) => `Restored ${name}`,
      showMore: 'Show more',
      showLess: 'Show less',
    },
    memory: {
      kinds: {
        preference: 'preference',
        decision: 'decision',
        lesson: 'lesson',
        fact: 'fact',
      },
      everyChat: 'Every chat',
      title: 'Memory',
      intro:
        'What every new chat starts knowing: your preferences and decisions, and lessons about each project. Agents propose memories during a chat; nothing is kept until you keep it.',
      remember: 'Remember something',
      rememberHint: 'One fact per memory, in a sentence.',
      rememberPlaceholder: 'e.g. I prefer pnpm over npm. Reports go in docs/reports/.',
      kind: 'Kind',
      appliesTo: 'Applies to',
      onlyProject: (name: string) => `Only ${name}`,
      rememberButton: 'Remember',
      /** The remembered list as search names it. */
      listTitle: 'What is remembered',
      loading: 'Loading memory…',
      emptyTitle: 'Nothing remembered yet',
      emptyBody: 'Add something above, or keep a memory an agent proposes in a chat.',
      edit: 'Edit',
      fromAgent: (agent: string) => `from ${agent}`,
      anAgent: 'an agent',
      addedByYou: 'added by you',
      waiting: 'waiting for you',
      why: (why: string) => `Why: ${why}`,
      keep: 'Keep',
      forget: 'Forget this',
      confirmForget: 'Yes, forget this memory',
    },
    shortcuts: {
      title: 'Keyboard shortcuts',
      newTask: 'New chat',
      focusComposer: 'Focus the message box',
      toggleSidebar: 'Toggle sidebar',
      toggleWorkspace: 'Toggle workspace',
      openSettings: 'Open settings',
      searchSettings: 'Search settings, while Settings is open',
      send: 'Send message',
      newLine: 'New line',
      takeWord: 'Take the next word of a suggestion',
      takeSuggestion: 'Take the whole suggestion',
      close: 'Close sheets, menus and panels',
      muteCall: 'Mute or unmute a call',
      hangUp: 'Hang up a call',
      /** ⌥⌘1 to ⌥⌘0 open the workspace panel's views in the order they sit down its rail. */
      workspaceView: 'Show a workspace view, in rail order',
      commandMenu: 'Command menu: chats, projects, settings and actions',
      showShortcuts: 'Show keyboard shortcuts',
      /** ⌘1 to ⌘9 open the chats in the order the sidebar lists them. */
      jumpToChat: 'Open a chat, in sidebar order',
      previousChat: 'Previous chat',
      nextChat: 'Next chat',
      stopRun: 'Stop the run',
      groups: { app: 'App', window: 'Window', chat: 'Chat', calls: 'Calls' },
    },
    about: {
      title: 'About Myrmidon',
      intro: 'Crews of agents that plan, research, build, and review on your computer.',
      dataDirectory: 'Data folder',
      providersReady: 'Providers ready',
      providersReadyHint: 'Through oh-my-pi’s provider code, built into Myrmidon.',
      sandbox: 'Sandbox',
      eventLog:
        'Every run is recorded and checkpointed, so project changes can be rewound. Licensed under Apache-2.0.',
      builtOn: 'Built on oh-my-pi (providers, search, readers), pi-agent-core, and Cordis.',
    },
  },
}
