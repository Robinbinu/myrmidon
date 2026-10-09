import {
  effectivePreset,
  PERMISSION_PRESETS,
  type PermissionLevel,
  type PermissionPreset,
  type PermissionRule,
  sameTarget,
} from '@myrmidon/protocol'
import { X } from 'lucide-react'
import { useState } from 'react'
import { send } from '../api.ts'
import { ChipMenu, MenuHead, Option } from '../chat/TeamControls.tsx'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { MenuList, MenuSeparator } from '../ui/Popover.tsx'
import { Button, cn, IconButton } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { PERMISSIONS_POPOVER_PX } from '../ui-config.ts'
import { PRESET_ICONS, presetLabel, scopeLabel, targetText } from './describe.ts'

const t = copy.permissions
const DECISION_TONE: Record<PermissionRule['decision'], string> = {
  allow: 'text-ok-ink',
  ask: 'text-warn-ink',
  deny: 'text-bad-ink',
}

/**
 * The chat's permissions beside the message box: a pill that reads as the preset in effect ("Auto", "Full access"),
 * opening a panel to choose this chat's own preset ("Use project / global" first) and to see and remove what the chat
 * remembered from approval cards. Before a chat exists it sets the level the first message starts it with.
 */
export function ChatPermissions(props: {
  /** The chat, once it exists; without one the choice waits for the first message (`onPending`). */
  chatId?: string | undefined
  /** The chat's own level (or the new chat's pending one). */
  level?: PermissionLevel | undefined
  /** The project's level and name, when the chat works in one. */
  project?: { name: string; level: PermissionLevel } | undefined
  globalPreset: PermissionPreset
  /** A device with chats only can look but not change it. */
  canEdit: boolean
  onPending(level: PermissionLevel | undefined): void
  onSaved(): void
  onOpenSettings?(): void
}) {
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const own = props.level ?? { rules: [] }
  const levels = {
    global: { preset: props.globalPreset, rules: [] },
    ...(props.project ? { project: props.project.level } : {}),
    chat: own,
  }
  const eff = effectivePreset(levels)
  const above = effectivePreset({ ...levels, chat: { rules: [] } })
  const Icon = PRESET_ICONS[eff.preset]
  const floor = props.project?.level.preset === 'read-only'
  const save = async (next: PermissionLevel) => {
    if (!props.chatId) return props.onPending(next.preset || next.rules.length ? next : undefined)
    try {
      await send('PUT', `/api/chats/${props.chatId}/permissions`, next)
      props.onSaved()
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }
  const setPreset = (preset: PermissionPreset | undefined) => {
    const { preset: _, ...rest } = own
    void save(preset ? { ...rest, preset } : rest)
  }
  const label = (props.chatId ? t.chat.label : t.chat.newLabel)(presetLabel(eff.preset))
  return (
    <ChipMenu
      label={label}
      width={PERMISSIONS_POPOVER_PX}
      icon={<Icon className={cn('size-3.5 shrink-0', eff.preset === 'full' && 'text-warn-ink')} />}
      value={presetLabel(eff.preset)}
    >
      {(close) => (
        <>
          <MenuHead
            title={props.chatId ? t.chat.title : t.chat.newTitle}
            note={t.from(scopeLabel(eff.scope))}
          />
          {floor ? (
            <p className="px-2 pb-2 text-callout leading-snug text-muted">
              {t.readOnlyFloor(props.project?.name ?? '')}
            </p>
          ) : confirming ? (
            <div role="alert" className="mx-1 mb-1 rounded-md border border-warn/35 bg-warn-soft px-2.5 py-2">
              <p className="text-body font-semibold text-warn-ink">{t.confirmFullTitle}</p>
              <p className="mt-0.5 text-callout leading-snug text-fg-2">{copy.fullAccess.warning}</p>
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="borderless" onClick={() => setConfirming(false)}>
                  {t.cancel}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  // The confirmation replaced the list the person was in, so focus moves onto it.
                  autoFocus
                  onClick={() => {
                    setConfirming(false)
                    setPreset('full')
                    close()
                  }}
                >
                  {t.confirmFull}
                </Button>
              </div>
            </div>
          ) : (
            <MenuList label={t.presetsLabel}>
              <Option
                icon={<Inherited preset={above.preset} />}
                title={
                  props.project
                    ? t.inherit.project(presetLabel(above.preset))
                    : t.inherit.global(presetLabel(above.preset))
                }
                hint={t.inherit.hint}
                selected={!own.preset}
                onSelect={() => {
                  if (!props.canEdit) return
                  setPreset(undefined)
                  close()
                }}
              />
              {PERMISSION_PRESETS.map((p) => {
                const PresetIcon = PRESET_ICONS[p]
                return (
                  <Option
                    key={p}
                    icon={<PresetIcon className="size-4" />}
                    title={presetLabel(p)}
                    hint={t.presets[p].hint}
                    selected={own.preset === p}
                    onSelect={() => {
                      if (!props.canEdit) return
                      if (p === 'full' && own.preset !== 'full') return setConfirming(true)
                      setPreset(p)
                      close()
                    }}
                  />
                )
              })}
            </MenuList>
          )}
          {!props.canEdit && <p className="px-2 pb-1 text-small text-muted">{t.chat.fullOnly}</p>}
          {props.chatId && (
            <>
              <MenuSeparator />
              <MenuHead title={t.chat.remembered} />
              {own.rules.length === 0 ? (
                <p className="px-2 pb-1.5 text-callout leading-snug text-muted">{t.chat.nothing}</p>
              ) : (
                <ul className="flex flex-col pb-1">
                  {own.rules.map((r) => (
                    <li
                      key={`${r.kind}:${r.target}:${r.who ?? 'all'}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-fill"
                    >
                      <FEATURE_ICONS.chatGrants className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-body">{targetText(r)}</span>
                      <span className={cn('text-small font-medium', DECISION_TONE[r.decision])}>
                        {t.rules.decisions[r.decision]}
                      </span>
                      {props.canEdit && (
                        <IconButton
                          size="sm"
                          label={t.rules.remove(targetText(r))}
                          onClick={() =>
                            void save({ ...own, rules: own.rules.filter((x) => !sameTarget(x, r)) })
                          }
                        >
                          <X className="size-3" />
                        </IconButton>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {props.onOpenSettings && (
            <>
              <MenuSeparator />
              <button
                type="button"
                onClick={() => {
                  close()
                  props.onOpenSettings?.()
                }}
                className="flex w-full items-center gap-2 rounded-base px-2 py-1.5 text-left text-body text-fg-2 outline-none transition-colors hover:bg-fill hover:text-fg focus-visible:bg-fill"
              >
                <FEATURE_ICONS.permissions className="size-3.5" aria-hidden />
                {t.chat.all}
              </button>
            </>
          )}
        </>
      )}
    </ChipMenu>
  )
}

/** The inherited choice's glyph: the preset it stands for, quieter. */
function Inherited({ preset }: { preset: PermissionPreset }) {
  const Icon = PRESET_ICONS[preset]
  return <Icon className="size-4 opacity-60" />
}
