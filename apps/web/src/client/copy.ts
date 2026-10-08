/**
 * Every word the web client shows, grouped by screen and component. Text with values in it is a function of
 * those values; the components keep the layout and logic.
 *
 * Glossary: one word per concept wherever the person reads it. The code keeps older names (colony, round, team,
 * judge, verifier, verdict, observer, steer, queue, newTask); those stay identifiers and never reach the screen.
 *   chat        one conversation with the lead, listed in the sidebar. Not "task" or "conversation"; a task is only
 *               a card on the task board.
 *   crew        everyone working on a chat: the lead and its helpers. Not "colony" or "team". Each chat's crew and
 *               its history is listed under Crews, and Compare puts two crews side by side.
 *   lead        the agent you talk to; it plans and brings in helpers.
 *   helper      an agent working with the lead. Not "worker". In Swarm mode there is no lead and the agents are
 *               "peers", equals sharing one plan.
 *   specialist  a helper you defined once in Settings and bring back by name.
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
 *               channel, gateway, tool library). Revoke: access (devices, people). Discard: proposals. A confirm
 *               button repeats the verb and its object ("Delete hook").
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
    copyPath: 'Copy',
    copied: 'Copied',
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
    chipTitle: (label: string, model: string) => `${label}: ${model}`,
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
        hint: 'A lead assigns tasks to helpers, each on the model that fits',
      },
      swarm: {
        name: 'Swarm',
        hint: 'Equal peers share one plan, notes, and tasks; no boss',
      },
    },
    teamLabel: (swarm: boolean, n: number) =>
      swarm ? `Swarm · ${n} peer${n === 1 ? '' : 's'}` : `Orchestrated · ${n} helper${n === 1 ? '' : 's'}`,
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
    helpers: 'Helpers',
    /** The fold under the helpers setting that lists each helper and its model. */
    helperList: 'Who helps',
    deliveries: {
      steer: { label: 'Send now', hint: 'Read at the crew’s next step' },
      queue: { label: 'Send when done', hint: 'Read once the current work is done' },
    },
    attachedOnly: 'See the attached files.',
    reasoning: ' · reasoning',
    /** Writing to a crew member directly by typing @ and their name. */
    mention: {
      section: 'Write directly to',
      label: 'Crew members to write to',
    },
    teamDialog: 'Crew and models',
    teamHeading: 'Lead & helpers',
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
    toolFailed: (tool: string) => `${tool} failed:`,
    created: 'Created',
    updated: 'Updated',
    planned: 'Planned',
    taskDone: 'Task done:',
    sentBack: (task: string) => `Sent ${task} back:`,
    needsRework: 'Task needs rework:',
    broughtIn: 'Brought in',
    promptInjection: 'May have followed instructions from a web page:',
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
      runningCommand: 'running a command',
      waitingForJudge: 'waiting for the reviewer',
      bringingIn: (name: unknown) => `bringing in ${String(name ?? 'a helper')}`,
      planningTasks: 'planning tasks',
      writingReply: 'writing a reply',
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
    /** The one chip thinking, reviewer and helpers fold into when the toolbar is narrow. */
    team: {
      label: 'Crew',
      summary: (thinking: string, reviewer: string, helpers: string) =>
        `Crew: thinking ${thinking.toLowerCase()} · ${reviewer.toLowerCase()} · ${helpers.toLowerCase()}`,
    },
    /** One set of words for the helpers setting, used on the chip and in every summary of it. */
    helpers: {
      label: 'Helpers',
      none: 'No helpers',
      summary: (n: number, swarm: boolean, mode: string) =>
        `${n} ${swarm ? 'peer' : 'helper'}${n === 1 ? '' : 's'} · ${mode.toLowerCase()}`,
    },
    helperModes: {
      never: { title: 'Never', hint: 'The lead works alone, like a chat' },
      auto: { title: 'Auto', hint: 'The lead brings helpers in when a job needs them' },
      always: { title: 'Always', hint: 'Every message starts with the whole crew' },
    },
    stepper: {
      fewer: (label: string) => `Fewer ${label}`,
      more: (label: string) => `More ${label}`,
    },
    editor: {
      style: 'Style',
      orchestrated: 'Lead + helpers',
      swarm: 'Equal peers',
      peer: (n: number) => `Peer ${n}`,
      peerLower: (n: number) => `peer ${n}`,
      roleOf: (n: number) => `Role of helper ${n}`,
      helper: 'Helper',
      minReason: (window: string) => `Under ${window}: too small for a helper's tools`,
      remove: (who: string) => `Remove ${who}`,
      addPeer: 'Add peer',
      addHelperLabel: 'Add a helper',
      addHelper: 'Add helper…',
      custom: 'Custom',
      /** The saved specialists in the add-helper list. */
      yourSpecialists: 'Your specialists',
      specialistOf: (name: string, specialty: string) => `${name} · ${specialty}`,
      moreOnDemand: {
        label: 'More on demand',
        hint: 'Extra helpers the lead may add when the job needs them',
        stepper: 'extra helpers',
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
        description: 'A lead with helpers, or equal peers',
        options: {
          orchestrated: {
            label: 'Orchestrated',
            description: 'A lead plans and assigns work to helpers',
          },
          swarm: { label: 'Swarm', description: 'Equal peers agree a plan and claim the work' },
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
        { keys: ['@'], does: 'Write directly to a crew member by name' },
        { keys: ['Tab'], does: 'Complete the highlighted command' },
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

  sidebar: {
    label: 'Chats',
    hide: 'Hide sidebar',
    newTask: 'New chat',
    withShortcut: (action: string, combo: string) => `${action} (${combo})`,
    search: { placeholder: 'Search', label: 'Search chats' },
    /** Date headings for chats outside a project. */
    groups: { today: 'Today', yesterday: 'Yesterday', previous7Days: 'Previous 7 days', older: 'Older' },
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
      lead: 'Plans the work, brings in helpers, and answers you.',
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
      use: (tool: string) => `use ${tool}`,
    },
    approval: {
      wantsTo: (action: string) => `wants to ${action}`,
      deny: 'Deny',
      approve: 'Allow',
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
      "Agents in this project's chats work in the folder: they read and edit its files and run commands there.",
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
    failed: (project: string) =>
      `Couldn’t check what changed in ${project}: Myrmidon didn’t answer. Your files are untouched; try again in a moment.`,
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
    confirmRemove: 'Remove tool',
    /** Settings list when nothing has been kept yet. */
    empty:
      "When an agent makes itself a tool for a job, it shows in the chat's Files view. Choose Keep there and every new run starts with it.",
  },

  permissions: {
    title: (project: string) => `Permissions · ${project}`,
    modesLabel: 'What agents may do',
    modes: {
      auto: {
        label: 'Autonomous',
        hint: 'Agents edit files and run commands in the sandbox without asking. Every run is checkpointed, so you can rewind it.',
      },
      ask: {
        label: 'Ask first',
        hint: 'Each change to a project file and each shell command waits for you to allow it in the chat, except the commands you allow below.',
      },
      readOnly: {
        label: 'Read-only',
        hint: 'Agents read and analyse the project but cannot change it; the sandbox keeps the folder untouched. They propose changes instead.',
      },
    },
    /** The small mark beside a project's name. */
    mark: { readOnly: 'Read-only for agents', ask: 'Agents ask before changes' },
    allow: {
      label: 'Commands that run without asking, one prefix per line (chained or piped commands always ask)',
    },
    save: 'Save',
    appliesFrom: 'Applies from each chat’s next message in this project.',
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
      /** Before the names of the crew members the person wrote to directly. */
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
      /** The run is paused on a call the person has to approve. */
      approval: 'Waiting for you to allow a step',
      toTeam: 'Bringing in helpers',
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
      /** Each helper as "nova (researcher)". */
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
    retrying: 'Retrying…',
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
      emptyBody: 'The lead and any helpers it brings in appear here once the work starts.',
      workingOn: (subject: string) => `Working on ${subject}`,
      turns: 'turns',
      tokens: 'tokens',
      tools: 'tools',
    },
    shell: {
      emptyTitle: 'No shell commands yet',
      emptyBody:
        'Agents run commands in a sandbox that can write only to their working folder and, unless the project is Read-only, the project.',
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
      read: 'Read',
      unread: 'Not read yet',
    },
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
      learning: 'Reading this chat for a skill worth keeping…',
      learned: (name: string) => `Proposed a skill: ${name}. Keep or discard it below.`,
      nothingToLearn: 'Nothing in this chat worth keeping as a skill.',
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
      modeSwarm: 'Swarm: equal peers',
      modeOrchestrated: 'Orchestrated: a lead with helpers',
      noModelMatches: (query: string) => `No model matches “${query}”`,
      modelSwitched: (agents: string, model: string) => `${agents} now on ${model}, from the next step`,
      leadModel: (model: string) => `Lead model: ${model}`,
      thinkingUsage: 'Use /thinking low, medium, high, or auto',
      thinkingAuto: 'Thinking: each role decides',
      thinkingLevel: (level: string) => `Thinking: ${level} while the crew works`,
      openChatToExport: 'Open a chat to export it',
      stopping: 'Stopping the crew…',
      deleted: (title: string) => `Deleted “${title}”`,
      projectRemoved: (name: string) => `Removed ${name} from projects; its folder and chats are untouched`,
    },
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
      messagePeers: 'Message the peers while they work…',
      messageLead: 'Message the lead while it works…',
      followUp: 'Ask a follow-up or request changes…',
      /** Added when the chat has a crew: typing @ and a name writes to that crew member directly. */
      mentionHint: ' (@name writes to a crew member)',
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
        ` and its ${rounds === 1 ? 'run' : `${rounds} runs`} will be permanently removed from this Myrmidon: messages, files, logs, and agent transcripts. This can’t be undone.`,
      stillRunning: 'This chat is still running. It will be stopped first.',
      cancel: 'Cancel',
      deleting: 'Deleting…',
      confirm: 'Delete chat',
    },
    crewConsole: 'Crew',
    noCrews: 'No crews yet. Send a message in a chat and its crew shows here.',
    crewSelect: 'Crew',
  },

  colonyScreen: {
    /** Names shown in the activity stream for events that no agent sent. */
    agents: {
      system: 'system',
      you: 'you',
      observer: 'check-in',
      colony: 'crew',
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
    noAgents: 'No agents yet. The lead and its helpers show here once the run starts.',
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
      general: { label: 'General', hint: 'Theme, motion, shortcuts' },
      mascot: { label: 'You & mascot', hint: 'Your name, the greeting, its look' },
      specialists: { label: 'Specialists', hint: 'Agents you keep and bring back' },
      devices: { label: 'Devices', hint: 'Who can use this Myrmidon' },
      gateways: { label: 'Gateways', hint: 'Other Myrmidons, one window' },
      channels: { label: 'Channels', hint: 'Telegram, Slack, email and more' },
      voice: { label: 'Voice', hint: 'Calls with your crew' },
      models: { label: 'Models & providers', hint: 'Models, API keys, endpoints' },
      team: { label: 'Crew & budget', hint: 'Defaults and limits' },
      tools: { label: 'Tools', hint: 'Shell, web, files' },
      skills: { label: 'Skills', hint: 'Playbooks agents load' },
      plugins: { label: 'Plugins', hint: 'Skills, commands, hooks, servers' },
      hooks: { label: 'Hooks', hint: 'Commands around every tool' },
      schedules: { label: 'Schedules', hint: 'Requests that run on their own' },
      verification: { label: 'Reviewer', hint: 'Off, auto or always' },
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
      groups: { setup: 'Setup', agents: 'Agents', extend: 'Extend', you: 'You' },
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
    notify: {
      label: 'Notify me when a run finishes',
      hint: 'A desktop notification when a run is done (or stops) while Myrmidon is in the background, including scheduled ones.',
      unsupported: 'This browser does not support notifications.',
      blocked: 'Notifications are blocked for this site in your browser settings',
    },
    general: {
      title: 'General',
      intro: 'How Myrmidon looks and feels on this device.',
      theme: 'Theme',
      themeHint: 'System follows your operating system.',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      reduceMotion: 'Reduce motion',
      reduceMotionHint: 'Turn off animations and transitions.',
    },
    models: {
      title: 'Models',
      intro: (count: number, shown: number) =>
        `${count} models you can call right now, ${shown} shown in pickers. Switch off whole providers you don’t use, hide single models, and test any model with a one-line request.`,
      search: 'Search models',
      refreshed: 'Model lists refreshed from providers',
      refresh: 'Refresh',
      addModels: 'Add models',
      noMatch: 'No models match',
      none: 'No models yet',
      inPickers: 'In pickers',
      showProvider: (provider: string) => `Show ${provider} models in pickers`,
      testMs: (ms?: number) => `${ms} ms`,
      testFailed: 'failed',
      respondedIn: (time: string) => `Responded in ${time}`,
      test: 'Test',
      showModel: (name: string) => `Show ${name}`,
      hideModel: (name: string) => `Hide ${name}`,
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
      confirmSignOut: 'Sign out',
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
      confirmRemoveCredentials: 'Remove credentials',
      removedCredentials: (id: string) => `Removed ${id} credentials`,
      remove: (id: string) => `Remove ${id}`,
      confirmRemove: 'Remove provider',
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
      spendLimitHint: 'The run stops at this cost; at 80% agents are told to wrap up. 0 means no limit.',
      tokenLimit: 'Token limit per run',
      tokenLimitHint: 'Counts every token the models process, cached input included. 0 means no limit.',
      turns: 'Turns per agent',
      turnsHint: 'Each agent stops after this many turns.',
      observer: 'Check-in interval',
      observerHint: 'How often Myrmidon checks for stuck or idle agents and for time running out.',
      units: { minutes: 'min', dollars: '$', tokens: 'tok', seconds: 's' },
    },
    tools: {
      title: 'Tools',
      intro: 'What agents can use in new chats. Publishing, tasks, and review are always on.',
      groups: {
        shell: {
          label: 'Shell',
          hint: 'Run commands in a sandbox that can write only to the agent’s working folder and, unless the project is Read-only, the project.',
        },
        web: {
          label: 'Web search & fetch',
          hint: 'Search the internet and read pages, PDFs, repos, and papers with dedicated readers.',
        },
        files: {
          label: 'Working files',
          hint: 'A private working folder for drafts before publishing files.',
        },
        messaging: { label: 'Messaging', hint: 'Board posts, direct mail between agents, and shared notes.' },
        mcp: {
          label: 'MCP servers (tool connectors)',
          hint: 'Tools from the MCP servers below, for every agent that does hands-on work.',
        },
      },
      /** `sandbox` is the runtime's sandbox kind. */
      sandboxActive: (sandbox: string) =>
        sandbox === 'sandbox-exec'
          ? 'Sandbox on: macOS confines shell commands'
          : sandbox === 'bubblewrap'
            ? 'Sandbox on: bubblewrap confines shell commands'
            : `Sandbox on: ${sandbox}`,
      noSandbox: 'No OS sandbox found',
      sandboxedHint:
        'Shell commands and command checks can write only to the agent’s working folder and, unless the project is Read-only, the project.',
      unsandboxedHint:
        'No sandbox was found on the computer Myrmidon runs on, so the shell tool stays off. On Linux, install bubblewrap and restart Myrmidon.',
      rulesTitle: 'Per-tool rules',
      rulesSubtitle: 'ask before each call, or turn one tool off; applies to new runs',
      findTool: 'Find a tool',
      findToolPlaceholder: 'Find a tool, e.g. browser, shell, mcp',
      ruleFor: (tool: string) => `Rule for ${tool}`,
      allow: 'Allow',
      askFirst: 'Ask first',
      mcpDefault: 'Default: read-only tools run, others ask',
      readOnlyDefault: 'Default: runs (read-only)',
      changesDefault: 'Default: asks (can change things)',
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
      confirmRemove: 'Remove server',
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
      removeConfirm: 'Remove channel',
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
      makeOwnerConfirm: 'Make owner',
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
      declineConfirm: 'Decline request',
      people: 'Approved people',
      groups: 'Approved groups',
      owner: 'Owner',
      member: 'Member',
      revoke: 'Revoke',
      revokeName: (name: string) => `Revoke ${name}`,
      revokeConfirm: 'Revoke access',
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
        'Call your crew from the chat. The call assistant talks with you on a fast model, hands real work to the crew as a run, and tells you when it is done. Your voice becomes text, and replies become speech, on this Mac or through a cloud or any OpenAI-compatible service.',
      enabled: 'Voice calls',
      /** Sizes are written like "1.3 MB", or empty when the server does not say. */
      enabledHint: (sizes: { detector: string; turn: string; kitten: string }) =>
        `Off by default. Turning them on downloads, once, what is not here yet: the speech detector${sizes.detector && ` (${sizes.detector})`}, the turn model${sizes.turn && ` (${sizes.turn})`} and, for Kitten TTS, its model${sizes.kitten && ` (${sizes.kitten})`}. Phonon-2 is not installed for you: press Install below, and its model downloads the first time it starts. Cloud and endpoint engines download nothing. All are kept ready, so a call answers at once.`,
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
      providers: {
        phonon: 'On-device speech recognition (Phonon-2)',
        omp: 'Cloud (your signed-in providers)',
        endpoint: 'Your own service (OpenAI-compatible)',
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
        endpoint: 'Any service with the OpenAI audio API: Groq, OpenAI, a local whisper or Kokoro server…',
        endpointStt: 'Your audio is sent to this address to be transcribed.',
        endpointTts: 'What the call says is sent to this address to be spoken.',
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
      baseUrl: 'Address',
      model: 'Model',
      key: 'API key',
      keySet: 'Saved; type a new one to replace it',
      saveKey: 'Save key',
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
      confirmRemove: 'Remove gateway',
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
      confirmRevoke: 'Revoke access',
      confirmRevokeSelf: 'Revoke and lose access',
      revokeSelfWarning: 'This is the device you are using now: it loses access as soon as you revoke it.',
      revoked: (name: string) => `${name} can no longer use this Myrmidon`,
    },
    specialists: {
      title: 'Specialists',
      intro:
        'Helpers you define once and bring back. Each joins under its own name, works the way you describe, on its own model, with only the tools you allow. Add one to a crew from the composer, or the lead brings it in when the work fits it.',
      empty: 'No specialists yet.',
      emptyHint: 'Create one here, or save a helper that did well from its sheet in a chat.',
      add: 'New specialist',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Delete specialist',
      removed: (name: string) => `Deleted ${name}`,
      modelHint: "Leave it unset to use the crew's helper model.",
      useTeamModel: "Use the crew's model",
      saved: (name: string) => `Saved ${name}`,
      name: 'Name',
      nameHint: 'Lowercase, like ada or scout. You can write to it as @name.',
      specialty: 'Specialty',
      specialtyHint: 'What it is for, in a few words: data analyst, UI copywriter.',
      instructions: 'How it works',
      instructionsHint: 'Its own instructions: approach, standards, what to always or never do.',
      model: 'Model',
      teamModel: "The crew's helper model",
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
      intro:
        'What the mascot calls you, who writes the line it greets you with and names your chats, and how it looks.',
      name: 'Your name',
      nameHint: (account: string) => `Leave empty to use your computer account's name (${account}).`,
      greeting: 'Greeting',
      greetingHints: {
        model:
          'Your lead model writes it from what happened while you were away. Uses a few hundred tokens when there is news.',
        rules: 'Written by Myrmidon itself, from the same facts. No model calls.',
      },
      greetingModel: 'Lead',
      greetingRules: 'Built in',
      titles: 'Chat names',
      titlesHints: {
        model:
          'Your lead model names each chat from what it is about after a run (a chat that is only "hi" so far waits). Names you give are kept.',
        'first-message': 'Chats are named with their first message. No model calls.',
      },
      titlesModel: 'From the topic',
      titlesFirst: 'First message',
      preview: 'Preview',
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
    },
    reviewer: {
      hints: {
        off: "Never. The lead's final answer completes the run.",
        auto: 'When the lead decides the work deserves it: code, files, research with sources.',
        always: 'Every final answer, before the run completes; findings go back to the lead to fix.',
      },
      title: 'Reviewer',
      intro:
        'An independent model checks the work against your request. Choose its model under Crew & budget; one from another provider than the crew catches more.',
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
      workers: 'Helpers',
      workersHint: 'How helpers should do and report their part.',
      workersPlaceholder: 'e.g. Write tests first. Report blockers immediately.',
    },
    schedules: {
      presets: {
        hourly: 'Every hour',
        daily: 'Every day at 9:00',
        weekdays: 'Weekdays at 9:00',
        mondays: 'Mondays at 9:00',
      },
      title: 'Schedules',
      intro:
        'Requests that run by themselves, each in a new chat with your default crew and reviewer. Myrmidon must be running; notifications (General) say when one ends.',
      request: 'Request',
      requestPlaceholder: 'e.g. Summarize what changed in this repo since yesterday and flag anything risky.',
      when: 'When',
      custom: 'Custom (cron)',
      cronExpression: 'Cron expression',
      cronPlaceholder: 'e.g. 0 9 * * 1-5 (minute hour day month weekday)',
      project: 'Project',
      noProject: 'No project',
      deliver: 'Send results to',
      noDeliver: 'Only in the app',
      deliverTo: (channel: string) => `results to ${channel}`,
      scheduled: 'Scheduled',
      schedule: 'Schedule',
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
      confirmDelete: 'Delete schedule',
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
        "Commands run before or after a tool or when a run ends, so a rule always holds. They get the event as JSON on stdin; exit 2 blocks the tool, or after it tells the agent. Tool names are Myrmidon's (",
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
      confirmRemove: 'Remove plugin',
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
      confirmForget: 'Forget memory',
    },
    shortcuts: {
      title: 'Keyboard shortcuts',
      newTask: 'New chat',
      focusComposer: 'Focus the message box',
      toggleSidebar: 'Toggle sidebar',
      toggleWorkspace: 'Toggle workspace',
      openSettings: 'Open settings',
      send: 'Send message',
      newLine: 'New line',
      close: 'Close dialogs and panels',
      muteCall: 'Mute or unmute a call',
      hangUp: 'Hang up a call',
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
