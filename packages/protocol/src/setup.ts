/**
 * The first-run setup assistant's steps, in the order it shows them. Its last screen (Ready) sums them up and is not a
 * step anyone marks, so it is not listed here.
 */
export const SETUP_STEPS = [
  'welcome',
  'you',
  'models',
  'crew',
  'project',
  'voice',
  'channels',
  'alerts',
] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/** `done`: the person went through the step; `later`: they chose Set up later. */
export type SetupMark = 'done' | 'later'

/** Where the person is with setup, kept in Myrmidon's settings. */
export interface SetupState {
  /** When the assistant was finished (or left with Finish later); until then it opens in place of the home screen. */
  finishedAt?: string
  /** When the person dismissed the home screen's Finish setting up card: from then on it never shows by itself. */
  dismissedAt?: string
  steps: Partial<Record<SetupStep, SetupMark>>
}

/** What exists already, however it was set up (the assistant or Settings): a step whose thing exists shows as done. */
export type SetupHave = Partial<Record<SetupStep, boolean>>

export const isSetupStep = (value: unknown): value is SetupStep =>
  typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value)
