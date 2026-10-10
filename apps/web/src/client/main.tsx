import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ComputerOverlay } from './ComputerOverlay.tsx'
import { DeviceGate } from './DeviceGate.tsx'
import { StatusProvider } from './status.tsx'
import { installNativeBehavior } from './ui/platform.ts'
import { ToastProvider } from './ui/Toast.tsx'

installNativeBehavior()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root, {
  // The component stack says which component failed, which the error alone does not.
  onUncaughtError: (error, info) => console.error('React crashed:', error, info.componentStack),
}).render(
  // The desktop app's window over the screen while an agent drives the Mac shows only that.
  location.pathname === '/overlay' ? (
    <ComputerOverlay />
  ) : (
    <ToastProvider>
      <DeviceGate>
        <StatusProvider>
          <App />
        </StatusProvider>
      </DeviceGate>
    </ToastProvider>
  ),
)
