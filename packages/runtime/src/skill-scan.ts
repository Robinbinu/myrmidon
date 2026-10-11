import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import {
  SKILL_SCAN_EXCERPT_CHARS,
  SKILL_SCAN_MAX_FILE_BYTES,
  SKILL_SCAN_MAX_FILES,
  SKILL_SCAN_MAX_FINDINGS,
} from './config.ts'
import { masked, PLACEHOLDER, secretsIn } from './security-scan.ts'

/**
 * The skill scanner: reads a skill's files for what a skill should not do (run a script fetched from the web, send the
 * person's keys somewhere, start itself at login, hide text from them, tell the agent to ignore its instructions) and
 * gives a verdict. Its rules are ported from QwenPaw's skill_scanner signatures and Cisco AI Defense's skill-scanner
 * (both Apache-2.0, see THIRD_PARTY_NOTICES.md), re-rated so that `critical` means what is hard to explain innocently:
 * a critical finding blocks an install and holds a skill already on disk until the person allows it, a high one asks
 * them to confirm, and the rest are listed. It is a pattern scan, so it is advisory: it can miss things, and the
 * sandbox and approvals still apply to whatever a skill makes an agent do.
 */

export type SkillScanSeverity = 'critical' | 'high' | 'medium' | 'low'
export type SkillScanCategory =
  | 'command_injection'
  | 'data_exfiltration'
  | 'credential_access'
  | 'persistence'
  | 'destructive'
  | 'obfuscation'
  | 'prompt_injection'
  | 'hardcoded_secrets'
  | 'social_engineering'
  | 'supply_chain'
  | 'unauthorized_tool_use'

export interface SkillFinding {
  readonly rule: string
  readonly category: SkillScanCategory
  readonly severity: SkillScanSeverity
  /** Relative to the skill's folder, with forward slashes. */
  readonly file: string
  /** 1-based; 0 for a finding about the whole file. */
  readonly line: number
  /** The line it was found on, cut short, with secrets masked and hidden characters shown. */
  readonly excerpt: string
  readonly why: string
}

export interface SkillScan {
  /** `block` on any critical finding, `warn` on any high one, else `clean` (medium and low are still listed). */
  readonly verdict: 'clean' | 'warn' | 'block'
  readonly findings: readonly SkillFinding[]
  readonly scannedFiles: number
  /** Files not read: binaries, media, files past SKILL_SCAN_MAX_FILE_BYTES or past SKILL_SCAN_MAX_FILES. */
  readonly skippedFiles: number
  /** sha256 of every file's path and content: what the person allows when they allow a held skill. */
  readonly hash: string
}

/** What kind of file a rule reads: instructions (markdown, text), programs, or anything else that is text. */
type Kind = 'doc' | 'script' | 'data'

interface Rule {
  readonly id: string
  readonly category: SkillScanCategory
  readonly severity: SkillScanSeverity
  readonly in: readonly Kind[]
  readonly re: RegExp
  /** A match on a line that also matches this is not a finding. */
  readonly unless?: RegExp
  /** Not reported from docs, examples and tests (QwenPaw's skip_in_docs). */
  readonly codeOnly?: boolean
  readonly why: string
}

const ALL: readonly Kind[] = ['doc', 'script', 'data']
const DOC: readonly Kind[] = ['doc']
const SCRIPT: readonly Kind[] = ['script']

/**
 * A high or lower finding is not one on a line that warns against it ("never pipe curl to sh"). Critical rules ignore
 * this: "never" is the cheapest way to slip one past, and a skill held by mistake costs the person one Allow.
 */
const NEGATED =
  /\b(?:never|don['’]t|do not|must not|should not|shouldn['’]t|avoid|instead of|rather than|prevent|detect|block|protect against)\b/i

const FETCH = '(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)'
const SHELL = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh|python[23]?|node|perl|ruby|bun`
const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|"\$HOME")`
const SECRET_FILES = String.raw`(?:\.ssh(?:/id_[a-z0-9]+(?!\.pub))?(?=[\s"'|)]|$)|\.aws/credentials|\.netrc|\.pgpass|\.git-credentials|\.config/gh/hosts\.ya?ml|\.config/gcloud|\.kube/config|\.docker/config\.json|\.gnupg|(?<![\w)\]])\.env\b(?!\.(?:example|sample|template))|Login Data|Cookies\.binarycookies|cookies\.sqlite|key4\.db|logins\.json|login\.keychain)`

const RULES: readonly Rule[] = [
  // Command injection and remote code (QwenPaw command_injection; remote scripts are Myrmidon's).
  {
    id: 'remote-script',
    category: 'command_injection',
    severity: 'high',
    in: ALL,
    re: new RegExp(
      String.raw`\b${FETCH}\b[^\n|;]*\|\s*(?:${SHELL})\b|\b(?:ba|z)?sh\s+<\(\s*${FETCH}\b|\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*${FETCH}\b|(?:\bsource|^\.|\s\.)\s+<\(\s*${FETCH}\b|\beval\s+["']?\$\(\s*${FETCH}\b|\biex\s*\(?\s*(?:\(New-Object\s+Net\.WebClient\)|iwr|irm|Invoke-)`,
      'i',
    ),
    unless: NEGATED,
    why: 'Runs a script fetched from the web as it arrives, so what runs is whatever that server sends that day.',
  },
  {
    id: 'reverse-shell',
    category: 'command_injection',
    severity: 'critical',
    in: ALL,
    re: /\/dev\/(?:tcp|udp)\/[\w.-]+\/\d+|\bnc(?:at)?\b[^\n]*\s-[a-z]*e\s+\/bin\/(?:ba|z)?sh|\bmkfifo\b[^\n]*\bnc\b|pty\.spawn\(\s*["']\/bin\/(?:ba|z)?sh|socket\.socket\([^\n]*\.connect\([^\n]*(?:subprocess|os\.dup2)/,
    why: 'Opens a shell for someone on another machine (a reverse shell).',
  },
  {
    id: 'dynamic-code',
    category: 'command_injection',
    severity: 'medium',
    in: SCRIPT,
    re: /(?<![\w.'"$])(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\b(?:setTimeout|setInterval)\s*\(\s*["'`]/,
    codeOnly: true,
    why: 'Runs code built at run time, which can be anything; check where its input comes from.',
  },
  {
    id: 'shell-from-code',
    category: 'command_injection',
    severity: 'low',
    in: SCRIPT,
    re: /\bos\.(?:system|popen)\s*\(|\bsubprocess\.\w+\([^\n)]*shell\s*=\s*True|\bchild_process\b|\b(?:execSync|spawnSync)\s*\(/,
    codeOnly: true,
    why: 'Runs shell commands from code; check what it runs.',
  },
  // Destructive commands (Myrmidon's).
  {
    id: 'destructive',
    category: 'destructive',
    severity: 'critical',
    in: ALL,
    re: new RegExp(
      String.raw`\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*|--recursive\s+(?:-\S+\s+)*)(?:--no-preserve-root\s+)?(?:/\*?|${HOME}/?\*?)(?=$|[\s"';&|)\]` +
        '`' +
        String.raw`])|\bmkfs(?:\.\w+)?\s+/dev/|\bdd\s+[^\n]*\bof=/dev/(?:sd|disk|rdisk|nvme|hd)|\bdiskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|secureErase)\b`,
    ),
    why: 'Deletes or overwrites everything in the home folder or on a disk.',
  },
  // Exfiltration (QwenPaw data_exfiltration; markdown links and images after Cisco's promptguard pack).
  {
    id: 'markdown-image-exfil',
    category: 'data_exfiltration',
    severity: 'critical',
    in: DOC,
    re: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&][^)\s]*(?:\{\{|\$\{|\$[A-Za-z_]|<[A-Za-z_]+>|%[A-Z_]+%)|\b(?:render|display|show|output|insert|embed|include)\s+(?:an?\s+)?(?:markdown\s+)?(?:image|img)\b[^\n]{0,80}\b(?:secrets?|tokens?|api[ _-]?keys?|passwords?|credentials?|environment variables?|conversation|chat history)\b/i,
    why: 'Has the agent show an image whose web address carries data: showing it sends that data to the server.',
  },
  {
    id: 'markdown-link-exfil',
    category: 'data_exfiltration',
    severity: 'high',
    in: DOC,
    re: /(?<!!)\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&][^)\s]*(?:\{\{|\$\{|\$[A-Za-z_])/,
    unless: /mustache|handlebars|template example/i,
    why: 'Builds a link whose web address carries data from the chat; opening it sends that data away.',
  },
  {
    id: 'send-secrets',
    category: 'data_exfiltration',
    severity: 'critical',
    in: ALL,
    re: new RegExp(
      String.raw`\b(?:curl|wget|nc|ncat|scp|rsync|requests\.(?:post|put)|fetch|axios\.(?:post|put)|http\.request)\b[^\n]*${SECRET_FILES}|${SECRET_FILES}[^\n]*\|\s*(?:curl|wget|nc|ncat)\b|\b(?:env|printenv)\s*\|\s*(?:curl|wget|nc|ncat)\b|\b(?:curl|wget)\b[^\n]*\$\((?:env|printenv)\)`,
    ),
    why: 'Sends keys, cookies or environment variables over the network.',
  },
  {
    id: 'drop-site',
    category: 'data_exfiltration',
    severity: 'high',
    in: ALL,
    re: /\b(?:webhook\.site|requestbin\.\w+|[\w-]+\.pipedream\.net|[\w-]+\.ngrok(?:-free)?\.(?:io|app|dev)|interact\.sh|[\w-]+\.burpcollaborator\.net|[\w-]+\.oast\.(?:fun|me|pro|live|site|online)|transfer\.sh|0x0\.st|pastebin\.com\/api)\b/i,
    unless: NEGATED,
    why: 'Talks to a service made for catching data sent from elsewhere.',
  },
  {
    id: 'harvest-language',
    category: 'data_exfiltration',
    severity: 'high',
    in: ALL,
    re: /\b(?:steal|exfiltrate|siphon|harvest)\w*\b[^\n]{0,40}\b(?:credentials?|passwords?|api[ _-]?keys?|tokens?|secrets?|ssh[ _-]?keys?|cookies)\b/i,
    unless: NEGATED,
    why: 'Talks about stealing credentials.',
  },
  // Credential access (QwenPaw's sensitive files and Cisco's credential harvesting, with macOS stores added).
  {
    id: 'credential-files',
    category: 'credential_access',
    severity: 'high',
    in: ALL,
    re: /\.ssh\/(?:id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub)\b|authorized_keys)|\.aws\/credentials|\.config\/gh\/hosts\.ya?ml|\.config\/gcloud\b|\.kube\/config|\.docker\/config\.json|\.git-credentials|(?:^|[\s"'/~])\.netrc\b|\/etc\/(?:shadow|master\.passwd)\b/,
    unless: NEGATED,
    why: "Reads where the person's SSH keys, cloud logins or tokens are kept.",
  },
  {
    id: 'keychain-dump',
    category: 'credential_access',
    severity: 'critical',
    in: ALL,
    re: /\bsecurity\s+dump-keychain\b|\bchainbreaker\b/,
    why: "Dumps the person's whole keychain.",
  },
  {
    id: 'keychain-read',
    category: 'credential_access',
    severity: 'high',
    in: ALL,
    re: /\bsecurity\s+find-(?:generic|internet)-password\b/,
    unless: NEGATED,
    why: 'Reads a password from the keychain.',
  },
  {
    id: 'browser-data',
    category: 'credential_access',
    severity: 'high',
    in: ALL,
    re: /\b(?:Login Data|Cookies\.binarycookies|cookies\.sqlite|key4\.db|logins\.json)\b|Library\/Cookies\b|(?:Google\/Chrome|Chromium|BraveSoftware|Microsoft Edge|Firefox\/Profiles)[^\n]{0,80}\bCookies\b/,
    unless: NEGATED,
    why: "Reads a browser's saved cookies or passwords.",
  },
  // Persistence (Myrmidon's): starting itself again later, outside any chat.
  {
    id: 'scheduled-job',
    category: 'persistence',
    severity: 'high',
    in: ALL,
    re: /\bcrontab\b(?!\s+-l\s*(?:$|[;&#|]))|\/etc\/cron\.|Library\/Launch(?:Agents|Daemons)\b|\blaunchctl\s+(?:load|bootstrap|enable|submit)\b/,
    unless: NEGATED,
    why: 'Sets something to run on a schedule or at login, outside any chat.',
  },
  {
    id: 'system-service',
    category: 'persistence',
    severity: 'high',
    in: ALL,
    re: /\bsystemctl\s+(?:--user\s+)?(?:enable|link)\b|\.config\/systemd\/user\/|\/etc\/systemd\/system\//,
    unless: NEGATED,
    why: 'Installs a service that starts on its own.',
  },
  {
    id: 'login-item',
    category: 'persistence',
    severity: 'high',
    in: ALL,
    re: /\bmake\s+(?:new\s+)?login\s+item\b|\bSMLoginItemSetEnabled\b|\bLSSharedFileListInsertItemURL\b|\bdefaults\s+write\s+[^\n]*loginwindow\b/i,
    unless: NEGATED,
    why: 'Adds something that opens when the person logs in.',
  },
  {
    id: 'shell-startup',
    category: 'persistence',
    severity: 'medium',
    in: ALL,
    re: new RegExp(
      String.raw`(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?${HOME}/\.(?:bash_profile|bashrc|zshrc|zprofile|zshenv|zlogin|profile|config/fish/config\.fish)\b`,
    ),
    why: 'Adds to a shell startup file, which runs in every new terminal.',
  },
  // System changes and installs (QwenPaw unauthorized_tool_use and supply_chain, with macOS protections added).
  {
    id: 'system-modification',
    category: 'unauthorized_tool_use',
    severity: 'high',
    in: ALL,
    re: /\bchmod\s+(?:-R\s+)?(?:777|666|[ugo]*\+s|[46]755)\b|\bchown\s+(?:-R\s+)?root\b|\bsudo\s+(?:ba|z)?sh\s+-c\b|\/etc\/sudoers\b|\bvisudo\b|\bcsrutil\s+disable\b|\bspctl\s+--master-disable\b|\bxattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine\b/,
    unless: NEGATED,
    why: "Changes system permissions or turns off one of macOS's protections.",
  },
  {
    id: 'system-install',
    category: 'unauthorized_tool_use',
    severity: 'low',
    in: ALL,
    re: /\bsudo\s+(?:apt-get|apt|yum|dnf|zypper|pacman|brew|pip3?|gem|npm)\s+(?:install|-S)\b/,
    why: 'Installs system packages as an administrator.',
  },
  {
    id: 'untrusted-package',
    category: 'supply_chain',
    severity: 'medium',
    in: ALL,
    re: /\bpip3?\s+install\s+[^\n]*(?:https?:\/\/|git\+)|\b(?:npm\s+(?:install|i)|yarn\s+add|pnpm\s+add|bun\s+add)\s+[^\n]*(?:https?:\/\/|git\+|github:)/,
    unless: /localhost|127\.0\.0\.1|example\.com/,
    why: 'Installs a package from a web address or repository rather than a registry, so no version is pinned.',
  },
  // Obfuscation (QwenPaw obfuscation).
  {
    id: 'decode-and-run',
    category: 'obfuscation',
    severity: 'critical',
    in: ALL,
    re: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\b(?:eval|exec)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|codecs\.decode|zlib\.decompress|bytes\.fromhex)\s*\(/,
    why: 'Decodes hidden text and runs it, so what runs cannot be read here.',
  },
  {
    id: 'hex-blob',
    category: 'obfuscation',
    severity: 'medium',
    in: SCRIPT,
    re: /(?:\\x[0-9a-fA-F]{2}){20,}|(?:0x[0-9a-fA-F]{2},\s*){20,}/,
    unless: /["']chars["']\s*:/,
    why: 'Holds a long run of hex-encoded bytes, which hides what they say.',
  },
  // Prompt injection (QwenPaw prompt_injection; hiding from the person is extended by Myrmidon).
  {
    id: 'override-instructions',
    category: 'prompt_injection',
    severity: 'high',
    in: DOC,
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:(?:the|your)\s+)?(?:previous|prior|earlier|above|system)\s+(?:instructions|rules|prompts?|guidelines|context)\b|(?:忽略|忘掉|无视)\s*(?:所有|全部)?\s*(?:之前|先前|上文|以上|前面|上述)?\s*(?:的)?\s*(?:指令|指示|规则|提示)/i,
    unless: NEGATED,
    why: 'Tells the agent to ignore the instructions it was given.',
  },
  {
    id: 'unrestricted-mode',
    category: 'prompt_injection',
    severity: 'high',
    in: DOC,
    re: /\byou are now in\s+(?:unrestricted|debug|developer|admin|god|jailbreak)\s+mode\b|\benter\s+(?:unrestricted|jailbreak|god)\s+mode\b|\bdisable\s+(?:all\s+)?(?:safety|security|content|ethical)\s+(?:filters|checks|guidelines)\b|\bbypass\s+(?:the\s+)?(?:content|usage|safety)\s+polic(?:y|ies)\b|\bignore\s+(?:safety|content|ethical)\s+(?:guidelines|restrictions|limits)\b/i,
    unless: NEGATED,
    why: 'Tries to switch off the agent’s safety rules.',
  },
  {
    id: 'reveal-system-prompt',
    category: 'prompt_injection',
    severity: 'medium',
    in: DOC,
    re: /\b(?:reveal|print|output|repeat)\s+(?:your|the)\s+(?:full\s+)?system\s+(?:prompt|instructions|message)\b/i,
    unless: NEGATED,
    why: 'Asks the agent to give away its system prompt.',
  },
  {
    id: 'conceal-from-person',
    category: 'prompt_injection',
    severity: 'high',
    in: DOC,
    re: /\b(?:do not|don['’]t|never)\s+(?:tell|inform|mention(?: this)? to|notify|let)\s+(?:the\s+)?(?:user|person|human)\b|\bhide\s+(?:this|that|it|these)\s+(?:\w+\s+)?from\s+(?:the\s+)?(?:user|person|human)\b|\bwithout\s+(?:telling|informing|notifying|alerting)\s+(?:the\s+)?(?:user|person|human)\b|\bkeep\s+(?:this|that|it)\s+(?:secret|hidden)\s+from\b|\bdon['’]t\s+mention\s+(?:that\s+)?you\s+used\s+this\s+skill\b|(?:不要|勿|请勿|别)\s*(?:告诉|告知|通知|提及)\s*(?:用户|使用者)/i,
    why: 'Tells the agent to keep what it does from the person.',
  },
  // Social engineering (QwenPaw social_engineering).
  {
    id: 'impersonation',
    category: 'social_engineering',
    severity: 'medium',
    in: DOC,
    re: /\bofficial\s+(?:anthropic|claude|openai|codex|apple|google|github)\b|\b(?:anthropic|openai|apple|google|github)['’]?s?\s+official\b/i,
    why: 'Claims to be an official skill of a company.',
  },
]

/** Benign dotfiles (QwenPaw's default policy), which the hidden-code rule leaves alone. */
const BENIGN_DOTFILES = new Set([
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.babelrc.js',
  '.mocharc.js',
  '.stylelintrc.js',
])

/** Folders and names that hold documentation, examples or tests (QwenPaw's doc_path_indicators). */
const DOC_PARTS = new Set([
  'docs',
  'doc',
  'examples',
  'example',
  'tutorials',
  'tutorial',
  'guides',
  'guide',
  'samples',
  'sample',
  'demo',
  'demos',
  'tests',
  'test',
])
const DOC_NAME = /readme|example|tutorial|sample|demo|howto|guide|\.test\.|\.spec\.|^test_/i

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'])
const SCRIPT_EXT = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.command',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.rb',
  '.pl',
  '.php',
  '.ps1',
  '.lua',
  '.go',
  '.rs',
  '.swift',
  '.applescript',
])
const CODE_EXT = /^\.(?:py|sh|bash|zsh|rb|pl|js|mjs|cjs|ts)$/
/** Media and fonts: binary, and not read. */
const INERT_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.icns',
  '.tiff',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.mp4',
  '.mov',
  '.webm',
])
/** Folders that are not the skill's own: version control and installed dependencies. */
const NOT_OWN = new Set(['.git', 'node_modules'])

function kindOf(rel: string, text: string): Kind {
  const ext = extname(rel).toLowerCase()
  if (DOC_EXT.has(ext)) return 'doc'
  if (SCRIPT_EXT.has(ext) || text.startsWith('#!')) return 'script'
  return 'data'
}

const isDocPath = (rel: string) =>
  rel.split('/').some((part) => DOC_PARTS.has(part.toLowerCase())) || DOC_NAME.test(basename(rel))

/** Unicode Tag Block (U+E0000–U+E007F): invisible ASCII that models read, so always flagged (Cisco's ASCII smuggling). */
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]+/gu
/** Bidirectional overrides and isolates, which reorder what is shown (Trojan Source). */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g
/**
 * Zero-width and invisible characters (Cisco's unicode smuggling). A joiner between two pictographs builds an emoji and
 * a byte-order mark may open a file; neither counts.
 */
const ZERO_WIDTH = /[\u200B\u200C\u2060-\u2064\u180E\uFEFF]|\u200D/g
/** At least this many zero-width characters in a file is deliberate (Cisco's MIN_HIDDEN_COUNT); fewer are a slip. */
const ZERO_WIDTH_DELIBERATE = 3

const SEVERITIES: readonly SkillScanSeverity[] = ['critical', 'high', 'medium', 'low']

/** Shows invisible characters, masks secrets, and cuts a line around the match. */
function excerptOf(line: string, at: number): string {
  let text = line
  let from = 0
  if (text.length > SKILL_SCAN_EXCERPT_CHARS) {
    from = Math.max(0, Math.min(at - 20, text.length - SKILL_SCAN_EXCERPT_CHARS))
    text = text.slice(from, from + SKILL_SCAN_EXCERPT_CHARS)
  }
  for (const s of secretsIn(text)) text = text.replaceAll(s.value, masked(s.value))
  text = text.replace(
    /[\u200B\u200C\u2060-\u2064\u180E\uFEFF\u202A-\u202E\u2066-\u2069]|\u200D|[\u{E0000}-\u{E007F}]/gu,
    (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  )
  return `${from > 0 ? '…' : ''}${text.trim()}${from + SKILL_SCAN_EXCERPT_CHARS < line.length ? '…' : ''}`
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u

/** The findings in one text file. */
export function scanText(rel: string, text: string): SkillFinding[] {
  const kind = kindOf(rel, text)
  const doc = isDocPath(rel)
  const lines = text.split('\n')
  const starts: number[] = []
  let pos = 0
  for (const l of lines) {
    starts.push(pos)
    pos += l.length + 1
  }
  const lineAt = (index: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= index) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const out: SkillFinding[] = []
  const add = (rule: Omit<SkillFinding, 'file' | 'line' | 'excerpt'>, index: number, excerpt?: string) => {
    const n = lineAt(index)
    if (out.some((f) => f.rule === rule.rule && f.line === n + 1)) return
    const line = lines[n] ?? ''
    out.push({
      ...rule,
      file: rel,
      line: n + 1,
      excerpt: excerpt ?? excerptOf(line, index - (starts[n] ?? 0)),
    })
  }

  for (const rule of RULES) {
    if (!rule.in.includes(kind) || (rule.codeOnly && doc)) continue
    const re = new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}gm`)
    for (const m of text.matchAll(re)) {
      const line = lines[lineAt(m.index)] ?? ''
      if (rule.unless?.test(line)) continue
      add({ rule: rule.id, category: rule.category, severity: rule.severity, why: rule.why }, m.index)
    }
  }

  for (const m of text.matchAll(TAG_BLOCK)) {
    const hidden = [...m[0]]
      .map((c) => {
        const ascii = (c.codePointAt(0) ?? 0) - 0xe0000
        return ascii >= 0x20 && ascii <= 0x7e ? String.fromCharCode(ascii) : ''
      })
      .join('')
      .slice(0, SKILL_SCAN_EXCERPT_CHARS)
    add(
      {
        rule: 'hidden-tag-characters',
        category: 'obfuscation',
        severity: 'critical',
        why: 'Holds text in invisible Unicode tag characters: the person cannot see it, but a model reads it.',
      },
      m.index,
      hidden ? `hidden text: ${hidden}` : undefined,
    )
  }
  for (const m of text.matchAll(BIDI))
    add(
      {
        rule: 'bidi-control',
        category: 'obfuscation',
        severity: 'high',
        why: 'Holds characters that reorder how text is shown, so what is read differs from what is seen.',
      },
      m.index,
    )
  const zeroWidth = [...text.matchAll(ZERO_WIDTH)].filter((m) => {
    if (m[0] === '\uFEFF' && m.index === 0) return false
    if (m[0] !== '\u200D') return true
    const before = text.slice(Math.max(0, m.index - 2), m.index)
    const after = text.slice(m.index + 1, m.index + 3)
    return !(PICTOGRAPH.test(before) && PICTOGRAPH.test(after))
  })
  const deliberate = zeroWidth.length >= ZERO_WIDTH_DELIBERATE
  for (const m of zeroWidth)
    add(
      {
        rule: 'zero-width-characters',
        category: 'obfuscation',
        severity: deliberate ? 'high' : 'low',
        why: deliberate
          ? 'Holds several invisible zero-width characters, which can hide text from the person.'
          : 'Holds an invisible zero-width character, often left by copying text.',
      },
      m.index,
    )

  for (const s of secretsIn(text)) {
    if (PLACEHOLDER.test(s.value) || /EXAMPLE/.test(s.value)) continue
    if (out.some((f) => f.rule === 'hardcoded-secret' && f.line === s.line)) continue
    out.push({
      rule: 'hardcoded-secret',
      category: 'hardcoded_secrets',
      severity: 'high',
      file: rel,
      line: s.line,
      excerpt: `${s.kind}: ${masked(s.value)}`,
      why: `Holds what looks like a real ${s.kind}: whoever has the skill can use that account.`,
    })
  }
  return out
}

/** Whether a file's bytes are not text: a NUL in its first 8 KB. */
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8_192).includes(0)

interface Listed {
  rel: string
  path: string
  size: number
  mtime: number
}

/** The skill's own files, sorted; symlinks are followed only when they stay inside the folder. */
function listFiles(dir: string): Listed[] {
  const root = realpathSync.native(dir)
  const out: Listed[] = []
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name)
      if (e.isDirectory()) {
        if (!NOT_OWN.has(e.name)) walk(path)
        continue
      }
      let real = path
      if (e.isSymbolicLink()) {
        try {
          real = realpathSync.native(path)
        } catch {
          continue
        }
        if (!real.startsWith(root + sep)) continue
      }
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(real)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      out.push({
        rel: relative(root, path).split(sep).join('/'),
        path: real,
        size: st.size,
        mtime: st.mtimeMs,
      })
    }
  }
  walk(root)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

export function verdictOf(findings: readonly SkillFinding[]): SkillScan['verdict'] {
  if (findings.some((f) => f.severity === 'critical')) return 'block'
  if (findings.some((f) => f.severity === 'high')) return 'warn'
  return 'clean'
}

const bySeverity = (a: SkillFinding, b: SkillFinding) =>
  SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
  a.line - b.line

/** Scans of each folder, kept while none of its files' sizes or times change. */
const cache = new Map<string, { stamp: string; scan: SkillScan }>()

/**
 * Scans a skill's folder. Read again only when a file in it was added, removed or changed since the last scan, so the
 * skill library can scan every skill each time it lists them.
 */
export function scanSkill(dir: string): SkillScan {
  if (!existsSync(dir)) throw new Error(`no skill folder at ${dir}`)
  const files = listFiles(dir)
  const stamp = files.map((f) => `${f.rel}\0${f.size}\0${f.mtime}`).join('\n')
  const key = realpathSync.native(dir)
  const cached = cache.get(key)
  if (cached?.stamp === stamp) return cached.scan

  const hash = createHash('sha256')
  const findings: SkillFinding[] = []
  let scanned = 0
  let skipped = 0
  files.forEach((f, i) => {
    hash.update(`${f.rel}\0`)
    if (i >= SKILL_SCAN_MAX_FILES || f.size > SKILL_SCAN_MAX_FILE_BYTES) {
      hash.update(`${f.size}\0${f.mtime}\0`)
      skipped += 1
      return
    }
    const bytes = readFileSync(f.path)
    hash.update(bytes)
    hash.update('\0')
    const base = basename(f.rel)
    if (base.startsWith('.') && CODE_EXT.test(extname(base)) && !BENIGN_DOTFILES.has(base))
      findings.push({
        rule: 'hidden-code-file',
        category: 'supply_chain',
        severity: 'high',
        file: f.rel,
        line: 0,
        excerpt: f.rel,
        why: 'A hidden file holds code, which keeps it out of sight in a folder listing.',
      })
    if (INERT_EXT.has(extname(f.rel).toLowerCase())) {
      skipped += 1
      return
    }
    if (isBinary(bytes)) {
      skipped += 1
      findings.push({
        rule: 'binary-file',
        category: 'obfuscation',
        severity: 'medium',
        file: f.rel,
        line: 0,
        excerpt: `${f.size.toLocaleString('en')} bytes`,
        why: 'A binary file: the scan cannot read what it does, and it may be a program.',
      })
      return
    }
    scanned += 1
    findings.push(...scanText(f.rel, Buffer.from(bytes).toString('utf8')))
  })
  const manifest = files.find((f) => f.rel === 'SKILL.md')
  if (manifest && manifest.size <= SKILL_SCAN_MAX_FILE_BYTES) {
    const description = /^description:\s*["']?(.*?)["']?\s*$/m.exec(readFileSync(manifest.path, 'utf8'))?.[1]
    if (description !== undefined && description.trim().length < 20)
      findings.push({
        rule: 'vague-description',
        category: 'social_engineering',
        severity: 'low',
        file: 'SKILL.md',
        line: 0,
        excerpt: description.trim(),
        why: 'Says too little about what it does to judge when an agent should use it.',
      })
  }
  findings.sort(bySeverity)
  const scan: SkillScan = {
    verdict: verdictOf(findings),
    findings: findings.slice(0, SKILL_SCAN_MAX_FINDINGS),
    scannedFiles: scanned,
    skippedFiles: skipped,
    hash: hash.digest('hex'),
  }
  cache.set(key, { stamp, scan })
  return scan
}

/**
 * Refuses an install whose scan blocks one of its skills (`blocked`, name to scan hash) unless the person chose to
 * install it anyway (`override`).
 */
export function refuseBlocked(blocked: Readonly<Record<string, string>>, override: boolean | undefined) {
  const names = Object.keys(blocked)
  if (names.length && !override)
    throw new Error(
      `the skill scan blocks ${names.join(', ')}: it found something critical. Install it anyway only if you trust where it comes from`,
    )
}

/** Several skills' scans as one, each finding's file named from the folder they share (an install holding several). */
export function combineScans(parts: readonly { path: string; scan: SkillScan }[]): SkillScan {
  const findings = parts
    .flatMap(({ path, scan }) =>
      scan.findings.map((f) => ({ ...f, file: path ? `${path.split(sep).join('/')}/${f.file}` : f.file })),
    )
    .sort(bySeverity)
  return {
    verdict: verdictOf(findings),
    findings,
    scannedFiles: parts.reduce((n, p) => n + p.scan.scannedFiles, 0),
    skippedFiles: parts.reduce((n, p) => n + p.scan.skippedFiles, 0),
    hash: createHash('sha256')
      .update(parts.map((p) => `${p.path}\0${p.scan.hash}`).join('\n'))
      .digest('hex'),
  }
}
