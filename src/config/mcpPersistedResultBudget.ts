import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Default total bytes one MCP session may write for oversized results. */
export const DEFAULT_PERSISTED_RESULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Session byte budget for persisted oversized results; zero disables persistence. */
export const mcpPersistedResultBudgetSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .transform(Number)
  .pipe(z.number().int().safe().min(0));

const budgetConstraint =
  "REA_MCP_PERSISTED_RESULT_MAX_BYTES must be a decimal safe integer. It bounds the total bytes one MCP session writes for results larger than the response budget; 0 disables persistence and returns the response-budget error instead.";

/** Parse only the persisted-result budget without loading unrelated provider settings. */
export const parseMcpPersistedResultBudget = (
  value: string | undefined,
): Result<number, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_PERSISTED_RESULT_MAX_BYTES);
  const parsed = mcpPersistedResultBudgetSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(budgetConstraint, {
          settings: [
            {
              setting: "REA_MCP_PERSISTED_RESULT_MAX_BYTES",
              constraint: budgetConstraint,
            },
          ],
        }),
      );
};
