/**
 * omp's stream rules (TTSR): rule files and their conditions, the matcher that watches a streaming answer, and
 * /omfg's rule drafting from a conversation.
 */
export {
  parseRuleAgents,
  parseRuleConditionAndScope,
  type Rule,
  type RuleFrontmatter,
  ruleAppliesToAgent,
} from '@oh-my-pi/pi-coding-agent/capability/rule'
export {
  type TtsrCheckOptions,
  TtsrManager,
  type TtsrMatchContext,
  type TtsrOutput,
} from '@oh-my-pi/pi-coding-agent/export/ttsr'
export {
  extractGeneratedRuleJson,
  parseGeneratedRule,
  sanitizeRuleName,
  validateParsedRuleAgainstAssistantHistory,
} from '@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule'
export { type TtsrTool, TtsrToolInspector } from '@oh-my-pi/pi-coding-agent/session/ttsr-outputs'
