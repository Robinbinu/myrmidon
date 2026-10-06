import { useEffect, useRef, useState } from 'react'
import type { ModelOption, TeamConfig } from '../api.ts'
import { ModelPicker } from './ModelPicker.tsx'

export function Composer(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(config: TeamConfig): void
  running: boolean
  busy: boolean
  placeholder: string
  onSend(text: string): Promise<void>
  onStop(): void
}) {
  const [text, setText] = useState('')
  const [showTeam, setShowTeam] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const { config } = props

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the textarea whenever its text changes
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const send = async () => {
    const value = text.trim()
    if (!value || props.busy) return
    setText('')
    try {
      await props.onSend(value)
    } catch {
      setText(value)
    }
  }

  const set = (patch: Partial<TeamConfig>) => props.onConfig({ ...config, ...patch })
  const teamLabel =
    config.mode === 'auto'
      ? `Auto · up to ${config.workers} worker${config.workers === 1 ? '' : 's'}`
      : `Manual · ${config.workers} worker${config.workers === 1 ? '' : 's'}`

  return (
    <div className="composer">
      {showTeam && (
        <div className="team-panel">
          <div className="team-row">
            <span className="team-title">Team</span>
            <fieldset className="segmented">
              <legend className="sr-only">Team mode</legend>
              {(['auto', 'manual'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={config.mode === mode}
                  className={config.mode === mode ? 'on' : ''}
                  onClick={() => set({ mode })}
                >
                  {mode === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </fieldset>
            <label className="stepper">
              <span>{config.mode === 'auto' ? 'Max workers' : 'Workers'}</span>
              <button
                type="button"
                onClick={() => set({ workers: Math.max(0, config.workers - 1) })}
                aria-label="Fewer workers"
              >
                −
              </button>
              <output>{config.workers}</output>
              <button
                type="button"
                onClick={() => set({ workers: Math.min(8, config.workers + 1) })}
                aria-label="More workers"
              >
                +
              </button>
            </label>
          </div>
          <p className="muted small">
            {config.mode === 'auto'
              ? 'The lead plans the work and spawns workers only when they help.'
              : 'Every worker starts with the lead; the lead assigns them tasks.'}
          </p>
          <div className="team-models">
            <ModelPicker
              label="Lead"
              value={config.leadModel}
              models={props.models}
              onChange={(leadModel) => set({ leadModel })}
            />
            <ModelPicker
              label="Workers"
              value={config.workerModel}
              models={props.models}
              onChange={(workerModel) => set({ workerModel })}
            />
            <ModelPicker
              label="Judge"
              value={config.judgeModel}
              models={props.models}
              onChange={(judgeModel) => set({ judgeModel })}
            />
          </div>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          aria-label="Message"
        />
        <div className="composer-bar">
          <button
            type="button"
            className="chip"
            onClick={() => setShowTeam(!showTeam)}
            aria-expanded={showTeam}
          >
            ⬡ {teamLabel}
          </button>
          <span className="chip muted" title="Lead model">
            {props.models.find((m) => m.ref === config.leadModel)?.name ?? config.leadModel}
          </span>
          <span className="spacer" />
          {props.running && (
            <button type="button" className="stop" onClick={props.onStop}>
              ■ Stop
            </button>
          )}
          <button
            type="button"
            className="send"
            onClick={() => void send()}
            disabled={!text.trim() || props.busy}
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </div>
      <div className="composer-hint muted small">
        Enter to send · Shift+Enter for a new line · messages sent while the colony works go straight to the
        lead
      </div>
    </div>
  )
}
