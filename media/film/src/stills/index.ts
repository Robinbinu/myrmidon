import type { ComponentType } from 'react'
import { Banner, BH, BW } from './Banner.tsx'
import { FeatureChannels } from './Channels.tsx'
import { FeatureComputer } from './Computer.tsx'
import { PH, PW } from './kit.tsx'
import { FeatureMemory } from './Memory.tsx'
import { FeatureModels } from './Models.tsx'
import { FeatureSafety } from './Safety.tsx'
import { FeatureSkills } from './Skills.tsx'
import { FeatureVoice } from './Voice.tsx'

/**
 * The README stills. Each id is also its file name: `npm run stills` renders every composition whose id is `banner` or
 * starts with `feature-` into docs/assets/<id>.webp.
 */
export const STILLS: { id: string; component: ComponentType; width: number; height: number }[] = [
  { id: 'banner', component: Banner, width: BW, height: BH },
  { id: 'feature-skills', component: FeatureSkills, width: PW, height: PH },
  { id: 'feature-channels', component: FeatureChannels, width: PW, height: PH },
  { id: 'feature-computer', component: FeatureComputer, width: PW, height: PH },
  { id: 'feature-models', component: FeatureModels, width: PW, height: PH },
  { id: 'feature-memory', component: FeatureMemory, width: PW, height: PH },
  { id: 'feature-safety', component: FeatureSafety, width: PW, height: PH },
  { id: 'feature-voice', component: FeatureVoice, width: PW, height: PH },
]
