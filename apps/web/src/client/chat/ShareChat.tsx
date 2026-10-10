import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import type { ChatSummary } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Banner, Button, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { shareChat } from './export.ts'

const t = copy.share

/**
 * Sharing a chat as an encrypted file. Nothing happens until the person presses Create; then the page is fetched from
 * this Myrmidon, sealed in this browser and saved to their downloads, and the key is shown here once.
 */
export function ShareChat(props: { chat: ChatSummary; onClose(): void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const keyId = useId()
  const [made, setMade] = useState<{ key: string; fileName: string }>()
  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setMade(await shareChat(props.chat))
    } catch (err) {
      setError(t.failed(String((err as Error).message ?? err)))
    } finally {
      setBusy(false)
    }
  }
  if (!made)
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body leading-relaxed text-fg-2">{t.intro}</p>
        <p className="text-callout leading-relaxed text-muted">{t.noHost}</p>
        {error && <Banner tone="bad">{error}</Banner>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void create()}
            icon={<FEATURE_ICONS.shareFile className="size-3.5" />}
          >
            {busy ? t.creating : t.create}
          </Button>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-fg">{t.saved(made.fileName)}</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-callout font-semibold text-fg-2">
          {t.keyLabel}
        </label>
        <div className="flex items-center gap-2">
          <TextInput
            id={keyId}
            readOnly
            value={made.key}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 font-mono"
            spellCheck={false}
          />
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(made.key).then(() => toast(t.keyCopied, 'success'))
            }
            icon={<Copy className="size-3.5" />}
          >
            {t.copyKey}
          </Button>
        </div>
      </div>
      <p className="text-callout leading-relaxed text-muted">{t.keyHint}</p>
      <p className="text-callout leading-relaxed text-muted">{t.howToOpen}</p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={props.onClose}>
          {t.done}
        </Button>
      </div>
    </div>
  )
}
