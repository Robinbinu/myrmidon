import { fileURLToPath } from 'node:url'
import type { ElectrobunConfig } from 'electrobun'

// A development build runs the server from this checkout (main/index.ts reads it back).
const repo = fileURLToPath(new URL('../..', import.meta.url))

export default {
  app: {
    name: 'Myrmidon',
    identifier: 'dev.myrmidon.app',
    version: '0.1.0',
  },
  build: {
    // The real Bun runtime, as the rest of Myrmidon uses, with bun:ffi for the Dock badge.
    mainProcess: 'bun',
    bun: {
      entrypoint: 'main/index.ts',
      // Only in a development build: a release build runs its bundled server and would carry this machine's path.
      ...(process.env.ELECTROBUN_BUILD_ENV === 'dev'
        ? { define: { 'process.env.MYRMIDON_DESKTOP_REPO': JSON.stringify(repo) } }
        : {}),
    },
    mac: {
      // Voice calls use the microphone, which a signed app with the hardened runtime may use only with this
      // entitlement. Its usage text goes into Info.plist from scripts/bundle-hook.ts.
      entitlements: { 'com.apple.security.device.audio-input': true },
      // The favicon on Apple's icon grid; scripts/icons.ts renders it from assets/icon.svg.
      icons: 'assets/icon.iconset',
      // scripts/make-dmg.ts makes the disk image: hdiutil's own sizing now leaves the volume too small for the app
      // ("No space left on device"), and Electrobun gives it no size.
      createDmg: false,
    },
    linux: {
      // The 1024 px PNG for desktop entries, window and taskbar.
      icon: 'assets/icon.iconset/icon_512x512@2x.png',
    },
    win: {
      // 16 to 256 px, packed from the iconset by scripts/icons.ts.
      icon: 'assets/icon.ico',
    },
  },
  scripts: {
    postBuild: './scripts/bundle-hook.ts',
    postWrap: './scripts/bundle-hook.ts',
  },
} satisfies ElectrobunConfig
