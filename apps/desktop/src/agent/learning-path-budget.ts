/** One learning-path size for the prompt, the tool descriptions, and the session cap. */
export const LEARNING_PATH_BUDGET = {
  maxRounds: 10,
  maxToolCalls: 12,
  minSearches: 4,
  maxSearches: 6,
  searchLimit: 12,
  minStages: 4,
  maxStages: 6,
  minNodes: 16,
  maxNodes: 28,
} as const;

export type LearningPathBudget = typeof LEARNING_PATH_BUDGET;
