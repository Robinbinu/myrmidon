import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ToastProvider } from './ui/Toast.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
)
