import { useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { crewFor } from './chat/hero-crew.ts'
import { copy } from './copy.ts'
import type { MascotLook, MascotPatch } from './mascot.ts'
import { useSpecialists } from './specialists.ts'
import { type Clip, IDLE_CLIPS } from './ui/clips.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { BOW, FLOWER, inkOn, PixelFace, PixelSprite } from './ui/pixel.tsx'
import {
  Button,
  Card,
  CardRow,
  Field,
  SectionHeader,
  Segmented,
  Switch,
  TextInput,
} from './ui/primitives.tsx'
import { pacman } from './ui/shows.ts'
import { playBlip } from './ui/sounds.ts'
import { MASCOT_COLORS, MASCOT_IDLE, MASCOT_PREVIEW } from './ui-config.ts'

/** The mascot's resting eye colour as set: its own, or the theme's accent. */
export const eyeColorOf = (look: MascotLook) =>
  look.display.eyeColor === 'theme' ? 'var(--accent)' : MASCOT_COLORS[look.color]

/** The mascot's screen at a size for pickers: its eyes in the chosen style and colour, with its accessory. */
export function MiniMascot(props: {
  look: MascotLook
  cell?: number
  clip?: Clip
  playId?: number
  onClipEnd?(): void
}) {
  const cell = props.cell ?? 4
  const { display } = props.look
  return (
    <span className="relative inline-block rounded-xl bg-screen p-2.5">
      <PixelFace
        mood="idle"
        color={eyeColorOf(props.look)}
        cols={15}
        rows={8}
        cell={cell}
        gap={cell * 0.3}
        eyes={props.look.eyes}
        look={[0, 0]}
        dots={display.dots}
        grid={display.grid}
        glow={display.glow}
        {...(props.clip ? { clip: props.clip, playId: props.playId ?? 0 } : {})}
        {...(props.onClipEnd ? { onClipEnd: props.onClipEnd } : {})}
      />
      {props.look.look === 'flower' && (
        <PixelSprite sprite={FLOWER} cell={cell * 0.85} className="absolute -right-2.5 -top-2.5" />
      )}
      {props.look.look === 'bow' && (
        <PixelSprite
          sprite={BOW}
          cell={cell * 0.75}
          className="absolute -bottom-2.5 left-1/2 -translate-x-1/2"
        />
      )}
    </span>
  )
}

/** The names the crew wears first, as the person chose. */
function useOwnCrewNames(crew: MascotLook['crew']): readonly string[] {
  const specialists = useSpecialists()
  if (crew.names === 'custom') return crew.custom
  if (crew.names === 'specialists') return (specialists ?? []).map((s) => s.name)
  return []
}

/**
 * The mascot as set up, alive: it plays its tricks at the chosen liveliness (sped up, so a setting shows within a few
 * seconds), and the crew it would bring stands under it. Still with less motion, as the real one is.
 */
export function MascotPreview(props: { look: MascotLook }) {
  const { look } = props
  const reduce = useReducedMotionConfig()
  const [play, setPlay] = useState<{ clip: Clip; id: number }>()
  useEffect(() => {
    if (reduce) return
    const chance = Math.min(1, MASCOT_IDLE.chance[look.idle] * MASCOT_PREVIEW.speedUp)
    let id = 0
    const t = setInterval(() => {
      setPlay((p) => {
        if (p || Math.random() >= chance) return p
        const playful = look.temper === 'playful'
        const pool = playful
          ? IDLE_CLIPS
          : IDLE_CLIPS.filter((c) => (MASCOT_IDLE.calmClips as readonly string[]).includes(c.name))
        const show =
          playful && look.shows.pacman && Math.random() < MASCOT_IDLE.showShare * MASCOT_PREVIEW.speedUp
        id += 1
        return { clip: show ? pacman() : (pool[Math.floor(Math.random() * pool.length)] as Clip), id }
      })
    }, MASCOT_IDLE.everyMs)
    return () => clearInterval(t)
  }, [reduce, look.idle, look.temper, look.shows.pacman])
  const own = useOwnCrewNames(look.crew)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new crew is drawn only when what it is made from changes
  const crew = useMemo(() => crewFor(look.crew.count, own), [look.crew.count, own.join('\u0000')])
  return (
    <figure
      className="m-0 flex flex-col items-center gap-4 py-4"
      aria-label={copy.settings.mascot.livePreview}
    >
      <MiniMascot
        look={look}
        cell={9}
        {...(play ? { clip: play.clip, playId: play.id } : {})}
        onClipEnd={() => setPlay(undefined)}
      />
      {look.crew.show && (
        <figcaption className="flex flex-wrap justify-center gap-1.5" aria-hidden>
          {crew.map((m) => (
            <span
              key={m.name}
              className="rounded-full px-2 py-0.5 text-caption font-semibold"
              style={{ background: m.color, color: inkOn(m.color) }}
            >
              {m.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  )
}

const group = (title: string, note: string, children: ReactNode) => (
  <section className="flex flex-col gap-2.5">
    <SectionHeader as="h4" title={title} note={note} />
    <Card>{children}</Card>
  </section>
)

/** Settings → You & mascot: liveliness, crew cursors, screen look and sounds, each a group with its own card. */
export function MascotBehaviour(props: { look: MascotLook; set(patch: MascotPatch): void }) {
  const t = copy.settings.mascot
  const { look, set } = props
  const specialists = useSpecialists()
  const [names, setNames] = useState(look.crew.custom.join(', '))
  const [crewSource, sourceHint] = [
    look.crew.names,
    look.crew.names === 'specialists'
      ? t.crewSourceHints.specialists((specialists ?? []).length)
      : t.crewSourceHints[look.crew.names],
  ]
  return (
    <div className="mt-8 flex flex-col gap-8">
      {group(
        t.liveliness,
        t.livelinessHint,
        <>
          <CardRow>
            <Field label={t.idle} inline>
              <Segmented
                id="mascot-idle"
                value={look.idle}
                options={(['off', 'rare', 'normal', 'often'] as const).map((v) => ({
                  value: v,
                  label: t.idleLevels[v],
                }))}
                onChange={(idle) => set({ idle })}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.shows}>
              <div className="flex flex-col gap-2.5">
                {(['pacman', 'life', 'confetti', 'boot'] as const).map((show) => (
                  <div key={show} className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-body text-fg">{t.showNames[show]}</p>
                      <p className="text-callout text-muted">{t.showHints[show]}</p>
                    </div>
                    <Switch
                      checked={look.shows[show]}
                      label={t.showNames[show]}
                      onChange={(on) => set({ shows: { [show]: on } })}
                    />
                  </div>
                ))}
              </div>
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.temper} hint={t.temperHints[look.temper]} inline>
              <Segmented
                id="mascot-temper"
                value={look.temper}
                options={(['calm', 'playful'] as const).map((v) => ({ value: v, label: t.tempers[v] }))}
                onChange={(temper) => set({ temper })}
              />
            </Field>
          </CardRow>
        </>,
      )}
      {group(
        t.crew,
        t.crewHint,
        <>
          <CardRow>
            <Field label={t.crewShow} inline>
              <Switch
                checked={look.crew.show}
                label={t.crewShow}
                onChange={(show) => set({ crew: { show } })}
              />
            </Field>
          </CardRow>
          {look.crew.show && (
            <>
              <CardRow>
                <Field label={t.crewCount} inline>
                  <Segmented
                    id="mascot-crew-count"
                    value={String(look.crew.count)}
                    options={['1', '2', '3', '4', '5', '6'].map((v) => ({ value: v, label: v }))}
                    onChange={(n) => set({ crew: { count: Number(n) } })}
                  />
                </Field>
              </CardRow>
              <CardRow>
                <Field label={t.crewNames} hint={sourceHint} inline>
                  <Segmented
                    id="mascot-crew-names"
                    value={crewSource}
                    options={(['minions', 'specialists', 'custom'] as const).map((v) => ({
                      value: v,
                      label: t.crewSources[v],
                    }))}
                    onChange={(source) => set({ crew: { names: source } })}
                  />
                </Field>
              </CardRow>
              {look.crew.names === 'custom' && (
                <CardRow>
                  <Field label={t.crewCustom} inline>
                    <TextInput
                      value={names}
                      placeholder={t.crewCustomPlaceholder}
                      aria-label={t.crewCustom}
                      onChange={(e) => {
                        setNames(e.target.value)
                        const list = e.target.value
                          .split(',')
                          .map((n) => n.trim().slice(0, 16))
                          .filter(Boolean)
                        set({ crew: { custom: [...new Set(list)].slice(0, 8) } })
                      }}
                      className="w-64"
                    />
                  </Field>
                </CardRow>
              )}
              <CardRow>
                <Field label={t.boldness} hint={t.boldnessHints[look.crew.boldness]} inline>
                  <Segmented
                    id="mascot-crew-boldness"
                    value={look.crew.boldness}
                    options={(['shy', 'curious', 'bold'] as const).map((v) => ({
                      value: v,
                      label: t.boldnessLevels[v],
                    }))}
                    onChange={(boldness) => set({ crew: { boldness } })}
                  />
                </Field>
              </CardRow>
            </>
          )}
        </>,
      )}
      {group(
        t.display,
        t.displayHint,
        <>
          <CardRow>
            <Field label={t.dots} inline>
              <Segmented
                id="mascot-dots"
                value={look.display.dots}
                options={(['led', 'round', 'square'] as const).map((v) => ({
                  value: v,
                  label: t.dotShapes[v],
                }))}
                onChange={(dots) => set({ display: { dots } })}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.grid} inline>
              <Segmented
                id="mascot-grid"
                value={look.display.grid}
                options={(['faint', 'tinted', 'off'] as const).map((v) => ({ value: v, label: t.grids[v] }))}
                onChange={(grid) => set({ display: { grid } })}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.glow} inline>
              <Segmented
                id="mascot-glow"
                value={look.display.glow}
                options={(['off', 'soft', 'strong'] as const).map((v) => ({ value: v, label: t.glows[v] }))}
                onChange={(glow) => set({ display: { glow } })}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.eyeColor} hint={t.eyeColorHints[look.display.eyeColor]} inline>
              <Segmented
                id="mascot-eye-color"
                value={look.display.eyeColor}
                options={(['own', 'theme'] as const).map((v) => ({ value: v, label: t.eyeColors[v] }))}
                onChange={(eyeColor) => set({ display: { eyeColor } })}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.size} inline>
              <Segmented
                id="mascot-size"
                value={look.display.size}
                options={(['small', 'medium', 'large'] as const).map((v) => ({
                  value: v,
                  label: t.sizes[v],
                }))}
                onChange={(size) => set({ display: { size } })}
              />
            </Field>
          </CardRow>
        </>,
      )}
      {group(
        t.sounds,
        t.soundsHint,
        <>
          <CardRow>
            <Field label={t.soundsOn} inline>
              <Switch
                checked={look.sounds.enabled}
                label={t.soundsOn}
                onChange={(enabled) => set({ sounds: { enabled } })}
              />
            </Field>
          </CardRow>
          {look.sounds.enabled && (
            <>
              <CardRow>
                <Field label={t.soundReactions} inline>
                  <Switch
                    checked={look.sounds.reactions}
                    label={t.soundReactions}
                    onChange={(reactions) => set({ sounds: { reactions } })}
                  />
                </Field>
              </CardRow>
              <CardRow>
                <Field label={t.soundTyping} inline>
                  <Switch
                    checked={look.sounds.typing}
                    label={t.soundTyping}
                    onChange={(typing) => set({ sounds: { typing } })}
                  />
                </Field>
              </CardRow>
              <CardRow>
                <Field label={t.volume} inline>
                  <div className="flex items-center gap-2">
                    <Segmented
                      id="mascot-volume"
                      value={look.sounds.volume}
                      options={(['quiet', 'normal', 'loud'] as const).map((v) => ({
                        value: v,
                        label: t.volumes[v],
                      }))}
                      onChange={(volume) => {
                        set({ sounds: { volume } })
                        playBlip('up', volume)
                      }}
                    />
                    <Button
                      size="sm"
                      icon={<FEATURE_ICONS.mascotSounds className="size-3.5" />}
                      onClick={() => playBlip('up', look.sounds.volume)}
                    >
                      {t.testSound}
                    </Button>
                  </div>
                </Field>
              </CardRow>
            </>
          )}
        </>,
      )}
    </div>
  )
}
