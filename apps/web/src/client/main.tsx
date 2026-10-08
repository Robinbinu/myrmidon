import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { DeviceGate } from './DeviceGate.tsx'
import { installNativeBehavior } from './ui/platform.ts'
import { ToastProvider } from './ui/Toast.tsx'

installNativeBehavior()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root, {
  // The component stack says which component failed, which the error alone does not.
  onUncaughtError: (error, info) => console.error('React crashed:', error, info.componentStack),
}).render(
  <ToastProvider>
    <DeviceGate>
      <App />
    </DeviceGate>
  </ToastProvider>,
)
