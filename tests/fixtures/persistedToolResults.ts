/**
 * Server environment whose oversized results keep the response-budget error
 * and its retained-Evidence recovery instead of a persisted result.
 */
export const persistedResultsDisabled = (): NodeJS.ProcessEnv => ({
  ...process.env,
  REA_MCP_PERSISTED_RESULT_MAX_BYTES: "0",
});
