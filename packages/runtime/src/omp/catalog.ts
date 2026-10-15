/**
 * omp's bundled model catalog: the models and providers it knows, whether a model's pricing is known, and a model's
 * thinking ladder with the effort on it nearest a requested one (as omp's own sessions clamp).
 */
export {
  clampThinkingLevelForModel,
  getBundledModel,
  getBundledProviders,
  getModelPricingStatus,
  getSupportedEfforts,
} from '@oh-my-pi/pi-catalog'
/** What a model id names (class, family, revision), the way omp picks a model's edit mode. */
export { classifyModel } from '@oh-my-pi/pi-catalog/identity'
