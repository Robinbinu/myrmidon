/** Every word the desktop shell shows or logs, in one place. The page itself uses apps/web/src/client/copy.ts. */
export const desktopCopy = {
  appName: 'Myrmidon',
  /** macOS asks with this the first time a voice call uses the microphone. */
  microphoneUsage: 'Myrmidon uses the microphone for voice calls with your crew.',
  starting: 'Starting Myrmidon…',

  menu: {
    about: 'About Myrmidon',
    settings: 'Settings…',
    hide: 'Hide Myrmidon',
    quit: 'Quit Myrmidon',
    file: 'File',
    newChat: 'New Chat',
    edit: 'Edit',
    view: 'View',
    commandMenu: 'Command Menu',
    toggleSidebar: 'Toggle Sidebar',
    reload: 'Reload',
    developerTools: 'Developer Tools',
    window: 'Window',
  },

  errors: {
    startTitle: 'Myrmidon could not start',
    exited: (code: number | null) =>
      `The Myrmidon server stopped while starting (exit code ${code ?? 'unknown'}).`,
    timeout: (seconds: number) => `The Myrmidon server did not answer within ${seconds} seconds.`,
    detail: 'Starting it from a terminal shows why: bun run myr serve',
    ok: 'Quit',
  },

  /** What the build hooks (scripts/) print. */
  build: {
    sidecarMissing: (path: string) =>
      `${path} is missing: run \`bun run desktop:sidecar\` before a release build`,
    addonMissing: (name: string) => `${name} not found under node_modules: run \`bun install\``,
    patched: (path: string) => `set the microphone usage description in ${path}`,
    copied: (path: string) => `copied the Myrmidon server into ${path}`,
  },
}
