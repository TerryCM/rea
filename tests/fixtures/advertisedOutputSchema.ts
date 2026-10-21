import { z } from "zod";

const advertisedOutputSchema = z.object({
  anyOf: z.tuple([
    z.record(z.string(), z.unknown()),
    z.object({ properties: z.object({ persisted_result: z.unknown() }) }),
  ]),
});

/**
 * The tool contract's own output projection, embedded beside the
 * persisted-result alternative in an advertised output schema.
 */
export const advertisedContractOutput = (
  advertised: Record<string, unknown>,
): Record<string, unknown> => advertisedOutputSchema.parse(advertised).anyOf[0];
