import { useState } from 'react'
import type { ModelOption, Specialist } from '../api.ts'
import { copy } from '../copy.ts'
import { specialistNameError } from '../settings-forms.ts'
import { type SpecialistDraft, saveSpecialist, useSpecialists } from '../specialists.ts'
import { Button, Field, Select, Switch, TextArea, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

const GROUPS = ['web', 'shell', 'files', 'browser', 'mcp'] as const

/**
 * A specialist's name, specialty, instructions, model and tools, as a form: for a new one, one being changed, or a
 * worker from a chat being kept (`initial` without an id).
 */
export function SpecialistEditor(props: {
  models: readonly ModelOption[]
  initial?: Partial<Specialist>
  onSaved(specialist: Specialist): void
  onCancel(): void
}) {
  const t = copy.settings.specialists
  const toast = useToast()
  const [draft, setDraft] = useState<SpecialistDraft>({
    name: props.initial?.name ?? '',
    specialty: props.initial?.specialty ?? '',
    instructions: props.initial?.instructions ?? '',
    model: props.initial?.model,
    off: props.initial?.off ?? [],
  })
  const [busy, setBusy] = useState(false)
  // A reason shows once the person has left a filled-in name, or for every field after a save that could not go ahead.
  const [tried, setTried] = useState(false)
  const [nameLeft, setNameLeft] = useState(false)
  const others = useSpecialists()
    .filter((s) => s.id !== props.initial?.id)
    .map((s) => s.name)
  const nameError = specialistNameError(draft.name, others)
  const specialtyError = draft.specialty.trim() ? undefined : copy.settings.validation.required
  const set = (patch: Partial<SpecialistDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const save = async () => {
    if (nameError || specialtyError) return setTried(true)
    setBusy(true)
    try {
      const saved = await saveSpecialist(draft, props.initial?.id)
      toast(t.saved(saved.name), 'success')
      props.onSaved(saved)
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  const visible = props.models.filter((m) => !m.hidden || m.ref === draft.model)
  // A worker kept from a chat brings its model even where the full list is not at hand.
  const extra = draft.model && !visible.some((m) => m.ref === draft.model) ? draft.model : undefined
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.name} hint={t.nameHint} error={nameLeft || tried ? nameError : undefined}>
          <TextInput
            value={draft.name}
            onBlur={(e) => e.target.value && setNameLeft(true)}
            onChange={(e) => set({ name: e.target.value.toLowerCase() })}
            maxLength={24}
            placeholder="ada"
            autoFocus
          />
        </Field>
        <Field label={t.specialty} hint={t.specialtyHint} error={tried ? specialtyError : undefined}>
          <TextInput
            value={draft.specialty}
            onChange={(e) => set({ specialty: e.target.value })}
            maxLength={60}
            placeholder="data analyst"
          />
        </Field>
      </div>
      <Field label={t.instructions} hint={t.instructionsHint}>
        <TextArea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={5}
          maxLength={8000}
        />
      </Field>
      <Field label={t.model}>
        <Select
          value={draft.model ?? ''}
          onChange={(e) => set({ model: e.target.value || undefined })}
          aria-label={t.model}
          className="w-full max-w-sm"
        >
          <option value="">{t.teamModel}</option>
          {extra && <option value={extra}>{extra}</option>}
          {visible.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.name} ({m.provider})
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t.tools}>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {GROUPS.map((g) => (
            <span key={g} className="inline-flex items-center gap-2 text-[13px]">
              <Switch
                checked={!draft.off.includes(g)}
                onChange={(on) => set({ off: on ? draft.off.filter((x) => x !== g) : [...draft.off, g] })}
                label={t.groups[g]}
              />
              {t.groups[g]}
            </span>
          ))}
        </div>
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {t.save}
        </Button>
      </div>
    </form>
  )
}
