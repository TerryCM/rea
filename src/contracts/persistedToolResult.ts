import { z } from "zod";

/** Leading UTF-8 bytes of a persisted result returned inline as its preview. */
export const PERSISTED_RESULT_PREVIEW_BYTES = 2048;

/**
 * Successful MCP delivery of a completed result whose complete response
 * exceeds the response budget. Every advertised output schema accepts this
 * alternative, so clients that validate structured content accept it too.
 * Every tool repeats it in tools/list, so it carries no descriptions: each
 * result's message explains itself, and docs/mcp-contracts.md documents it.
 */
export const persistedToolResultSchema = z.strictObject({
  persisted_result: z.strictObject({
    message: z.string().min(1),
    path: z.string().min(1),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    preview: z.string(),
    preview_truncated: z.boolean(),
    evidence_id: z.string().min(1).exactOptional(),
    continuation: z
      .strictObject({
        name: z.literal("inspect_analysis_view"),
        arguments: z.record(z.string(), z.unknown()),
      })
      .exactOptional(),
  }),
});

export type PersistedToolResult = z.infer<typeof persistedToolResultSchema>;
