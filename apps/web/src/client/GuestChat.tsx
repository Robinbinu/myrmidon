import { LogOut, SendHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type GuestView, guestSend, guestView, joinChat, leaveChat } from './api.ts'
import { Markdown } from './chat/Markdown.tsx'
import { copy } from './copy.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { Logo } from './ui/Logo.tsx'
import { Banner, Button, Field, TextArea, TextInput } from './ui/primitives.tsx'
import { GUEST_POLL_MS } from './ui-config.ts'
import { useColony, useLiveReplies } from './use-colony.ts'

const t = copy.guest

/** An invite's code from the link (`#join=…`), if the page was opened with one. */
export const joinCode = () => new URLSearchParams(location.hash.slice(1)).get('join') ?? undefined

/** Joining a chat someone shared live: the code from their link, and the name they will see. */
export function JoinScreen(props: { onJoined(): void }) {
  const [code, setCode] = useState(joinCode() ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const join = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await joinChat(code.trim(), name.trim())
      // The code is spent; keep it out of the address bar and history.
      history.replaceState(null, '', location.pathname)
      props.onJoined()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-line bg-surface p-6 shadow-pop"
        onSubmit={(e) => {
          e.preventDefault()
          void join()
        }}
      >
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-page-title font-semibold tracking-tight">{t.join.title}</h1>
            <p className="text-callout text-muted">{location.host}</p>
          </div>
        </div>
        <p className="text-reading leading-relaxed text-fg-2">{t.join.intro}</p>
        <Field label={t.join.code} hint={t.join.codeHint}>
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            aria-label={t.join.code}
            className="font-mono tracking-[0.12em]"
            autoComplete="one-time-code"
          />
        </Field>
        <Field label={t.join.name}>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            aria-label={t.join.name}
            autoComplete="name"
          />
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !code.trim() || !name.trim()}
          icon={<FEATURE_ICONS.liveShare className="size-4" />}
        >
          {t.join.join}
        </Button>
      </form>
    </div>
  )
}

/**
 * The page a guest of a shared chat sees: that chat's conversation as it happens and, with a write link, a box to
 * write in. Nothing else of the person's: no list of chats, Settings or files. It asks the server every few seconds
 * whether the chat works or waits, and ends when the guest is no longer in it.
 */
export function GuestChat() {
  const [view, setView] = useState<GuestView>()
  const [ended, setEnded] = useState<'removed' | 'left'>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (ended) return
    let alive = true
    const load = () =>
      guestView()
        .then((v) => {
          if (!alive) return
          setError(undefined)
          if (v) setView(v)
          else setEnded('removed')
        })
        .catch((err) => alive && setError((err as Error).message))
    void load()
    const timer = setInterval(() => void load(), GUEST_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [ended])

  if (ended)
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-4">
        <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-pop">
          <div className="flex items-center gap-3">
            <Logo size={36} />
            <h1 className="text-page-title font-semibold tracking-tight">{t.ended.title}</h1>
          </div>
          <p className="text-reading leading-relaxed text-fg-2">
            {ended === 'left' ? t.ended.left : t.ended.body}
          </p>
        </div>
      </div>
    )
  if (!view) return error ? <Banner tone="bad">{error}</Banner> : null
  const colonies = [...new Set(view.chat.rounds.map((r) => r.colonyId))]
  const running = view.chat.status === 'running'
  const status = view.chat.approving
    ? t.approving(view.host)
    : view.chat.awaiting
      ? t.awaiting(view.host)
      : running
        ? t.working
        : undefined
  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Logo size={28} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold text-fg">{view.chat.title}</h1>
          <p className="truncate text-callout text-muted">
            {t.sharedBy(view.host)} · {t.you(view.guest.name, view.guest.access)}
          </p>
        </div>
        <Button
          variant="borderless"
          icon={<LogOut className="size-3.5" />}
          onClick={() =>
            void leaveChat()
              .catch(() => {})
              .then(() => setEnded('left'))
          }
        >
          {t.leave}
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {colonies.length === 0 && <p className="text-callout text-muted">{t.empty}</p>}
          {colonies.map((id) => (
            <GuestRounds key={id} colonyId={id} />
          ))}
          {status && (
            <p role="status" className="text-callout text-muted">
              {status}
            </p>
          )}
          {error && <Banner tone="bad">{error}</Banner>}
        </div>
      </main>
      <footer className="border-t border-line px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {view.guest.access === 'write' ? (
            <GuestComposer host={view.host} />
          ) : (
            <p className="text-callout text-muted">{t.viewOnly}</p>
          )}
        </div>
      </footer>
    </div>
  )
}

/** The messages of the colony that ran the chat's rounds, and replies still being written. */
function GuestRounds(props: { colonyId: string }) {
  const colony = useColony(props.colonyId)
  const end = useRef<HTMLDivElement>(null)
  const messages = colony.state.chatMessages.filter((m) => !m.answers)
  const writing = Object.entries(useLiveReplies(colony.streams)).filter(([, live]) => live.text && !live.done)
  const count = messages.length + writing.length
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message or reply moves the page to it
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [count])
  if (colony.error) return <Banner tone="bad">{colony.error}</Banner>
  return (
    <>
      {messages.map((m) =>
        m.from === 'user' ? (
          <p
            key={m.id}
            className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-fill px-4 py-2.5 text-reading text-fg"
          >
            {m.text}
          </p>
        ) : (
          <div key={m.id} className="flex flex-col gap-1">
            <span className="text-callout font-semibold text-fg-2">{m.from}</span>
            <div className="text-reading text-fg">
              <Markdown text={m.text} />
            </div>
          </div>
        ),
      )}
      {writing.map(([agent, live]) => (
        <div key={`writing-${agent}`} className="flex flex-col gap-1" aria-busy="true">
          <span className="text-callout font-semibold text-fg-2">
            {agent} · {t.writing}
          </span>
          <div className="text-reading text-fg">
            <Markdown text={live.text} />
          </div>
        </div>
      ))}
      <div ref={end} />
    </>
  )
}

function GuestComposer(props: { host: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const sendIt = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await guestSend(text)
      setText('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void sendIt()
      }}
    >
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="flex items-end gap-2">
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void sendIt()
            }
          }}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          rows={2}
          className="min-w-0 flex-1 resize-none"
        />
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!text.trim()}
          icon={<SendHorizontal className="size-3.5" />}
        >
          {t.send}
        </Button>
      </div>
      <p className="text-callout text-muted">{t.asks(props.host)}</p>
    </form>
  )
}
