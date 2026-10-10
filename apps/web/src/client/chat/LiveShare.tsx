import { Copy } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import {
  type ChatShare,
  type ChatSummary,
  chatShare,
  inviteGuest,
  removeGuest,
  type ShareAccess,
  stopSharing,
  withdrawInvite,
} from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Banner, Button, Dot, Field, Segmented, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { SHARE_POLL_MS } from '../ui-config.ts'

const t = copy.liveShare

const until = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Sharing a chat live (after omp's `/collab`): a single-use invite to watch, or watch and write, and who is in now,
 * each of whom the person can remove. The server keeps all of it (ChatShares); this sheet asks it again every few
 * seconds while open, so someone joining shows up here.
 */
export function LiveShare(props: { chat: ChatSummary; onClose(): void }) {
  const chatId = props.chat.chatId
  const toast = useToast()
  const linkId = useId()
  const [share, setShare] = useState<ChatShare>()
  const [access, setAccess] = useState<ShareAccess>('view')
  const [made, setMade] = useState<{ link: string; code: string; expiresAt: string }>()
  const [busy, setBusy] = useState<'create' | 'change'>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(
    () =>
      chatShare(chatId)
        .then(setShare)
        .catch((err) => setError(t.failed(String((err as Error).message ?? err)))),
    [chatId],
  )
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), SHARE_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  /** Runs a change, then shows the server's view of the share again. */
  const act = async (change: () => Promise<unknown>, kind: 'create' | 'change' = 'change') => {
    setBusy(kind)
    setError(undefined)
    try {
      await change()
    } catch (err) {
      setError(t.failed(String((err as Error).message ?? err)))
    } finally {
      setBusy(undefined)
      await refresh()
    }
  }
  const create = () =>
    act(async () => {
      const r = await inviteGuest(chatId, access)
      setMade({ link: r.link, code: r.code, expiresAt: r.invite.expiresAt })
    }, 'create')
  const sharing = !!share && (share.invites.length > 0 || share.guests.length > 0)

  return (
    <div className="flex flex-col gap-5">
      <p className="text-body leading-relaxed text-fg-2">{t.intro}</p>
      {share && !share.remote && <Banner tone="warn">{t.localOnly}</Banner>}
      <Field label={t.access} hint={t.accessHint[access]}>
        <Segmented
          id={`${linkId}access`}
          value={access}
          onChange={setAccess}
          options={[
            { value: 'view', label: t.view },
            { value: 'write', label: t.write },
          ]}
        />
      </Field>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={busy === 'create'}
          disabled={!!busy}
          onClick={() => void create()}
          icon={<FEATURE_ICONS.liveShare className="size-3.5" />}
        >
          {busy === 'create' ? t.creating : t.create}
        </Button>
      </div>
      {made && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={linkId} className="text-callout font-semibold text-fg-2">
            {t.linkLabel}
          </label>
          <div className="flex items-center gap-2">
            <TextInput
              id={linkId}
              readOnly
              value={made.link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
            />
            <Button
              onClick={() =>
                void navigator.clipboard.writeText(made.link).then(() => toast(t.linkCopied, 'success'))
              }
              icon={<Copy className="size-3.5" />}
            >
              {t.copyLink}
            </Button>
          </div>
          <p className="text-callout leading-relaxed text-muted">
            {t.once(until(made.expiresAt))} {t.code(made.code)}
          </p>
        </div>
      )}
      {error && <Banner tone="bad">{error}</Banner>}

      <section className="flex flex-col gap-2" aria-label={t.guestsTitle}>
        <h3 className="text-callout font-semibold text-fg-2">{t.guestsTitle}</h3>
        {share?.guests.length ? (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {share.guests.map((g) => (
              <li key={g.id} className="flex items-center gap-3 px-3 py-2">
                <Dot tone={g.online ? 'ok' : 'neutral'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-fg">{g.name}</p>
                  <p className="text-callout text-muted">{t.guest(g.access, g.online)}</p>
                </div>
                <Button
                  variant="borderless"
                  disabled={!!busy}
                  aria-label={t.removeLabel(g.name)}
                  onClick={() => void act(() => removeGuest(chatId, g.id))}
                >
                  {t.remove}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-callout text-muted">{t.noGuests}</p>
        )}
      </section>

      {!!share?.invites.length && (
        <section className="flex flex-col gap-2" aria-label={t.invitesTitle}>
          <h3 className="text-callout font-semibold text-fg-2">{t.invitesTitle}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {share.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                <p className="min-w-0 flex-1 text-callout text-fg-2">
                  {t.invite(i.access, until(i.expiresAt))}
                </p>
                <Button
                  variant="borderless"
                  disabled={!!busy}
                  onClick={() => void act(() => withdrawInvite(chatId, i.id))}
                >
                  {t.withdraw}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-callout leading-relaxed text-muted">{t.restart}</p>
      <div className="flex items-center justify-end gap-2">
        {sharing && (
          <Button
            variant="danger"
            disabled={!!busy}
            title={t.stopHint}
            onClick={() =>
              void act(async () => {
                await stopSharing(chatId)
                setMade(undefined)
              })
            }
          >
            {t.stop}
          </Button>
        )}
        <Button variant="primary" onClick={props.onClose}>
          {t.done}
        </Button>
      </div>
    </div>
  )
}
