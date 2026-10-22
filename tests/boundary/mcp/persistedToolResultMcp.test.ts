import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  isCallToolResult,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  PERSISTED_RESULT_PREVIEW_BYTES,
  persistedToolResultSchema,
} from "../../../src/contracts/persistedToolResult.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { toolOutputSchemaWithMetadata } from "../../../src/contracts/toolSchemaMetadata.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import {
  jsonObjectSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { PersistedToolResultStore } from "../../../src/server/PersistedToolResultStore.js";
import { registerOfficialTools } from "../../../src/server/registerOfficialTools.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);
const provider = { id: "fixture", name: "Fixture", version: "1" };

const callPseudoCode = async (
  payload: string,
  maximumBytes = 1024 * 1024 * 1024,
  omitOutputSchemas = false,
) => {
  const parent = await createTestTempDirectory("rea-persisted-result-");
  const resources = new ArtifactResourceScope();
  const store = new PersistedToolResultStore(resources, {
    maximumBytes,
    parent,
  });
  const records = new Map<string, Evidence>();
  const recordEvidence = (evidence: Evidence) => {
    records.set(evidence.evidence_id, evidence);
    return ok("added" as const);
  };
  const server = new EvidenceMcpServer(
    { name: "persisted-result", version: "1" },
    { capabilities: {} },
    recordEvidence,
    delivery,
    undefined,
    omitOutputSchemas,
    store,
  );
  registerOfficialTools(server, {
    logger: silentLogger,
    activeTarget: undefined,
    recordEvidence,
    withAdmittedAnalysis: async (_operationName, _signal, operation) =>
      ok(
        await operation({
          execute: () =>
            Promise.resolve(
              ok(
                createAnalysisExecution(payload, provider, {
                  rawResult: payload,
                }),
              ),
            ),
        }),
      ),
  });
  // The SDK client validates structured content against the advertised
  // output schema, as MCP hosts do.
  const client = new Client({ name: "persisted-result-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = serverTransport.send.bind(serverTransport);
  let responseWire = "";
  serverTransport.send = (message, options) => {
    if (isJSONRPCResultResponse(message) && isCallToolResult(message.result))
      responseWire = JSON.stringify(message);
    return send(message, options);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([client.close(), server.close()]);
    await store.close();
    await resources.close();
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = (await client.listTools()).tools.find(
      ({ name }) => name === "procedure_pseudo_code",
    );
    const result = await client.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "main" },
    });
    return {
      result,
      responseWire,
      records,
      parent,
      store,
      close,
      outputSchema: advertised?.outputSchema,
    };
  } catch (cause: unknown) {
    await close();
    throw cause;
  }
};

const persistedOf = (structuredContent: unknown) =>
  persistedToolResultSchema.parse(structuredContent).persisted_result;

it("saves a completed result larger than the response budget and returns it successfully", async () => {
  // Evidence repeats the payload as normalized and raw observations, and
  // inline delivery repeats that JSON as structured content and text.
  const payload = "x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2);
  const call = await callPseudoCode(payload);
  try {
    const { result, responseWire, records } = call;
    expect(result.isError).not.toBe(true);
    const persisted = persistedOf(result.structuredContent);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
    expect(Buffer.byteLength(responseWire)).toBeLessThan(16 * 1024);
    expect(persisted.message).toContain(
      `the ${String(delivery.resultBudgetBytes)}-byte MCP response budget`,
    );
    // Pseudocode is target content: the saved-result notice stays marked.
    expect(result._meta).toEqual({
      provenance: { untrusted_content: true, source: "analysis_target" },
    });

    // The file holds the exact text inline delivery would have carried.
    const retained = records.get(persisted.evidence_id ?? "");
    if (retained === undefined) throw new Error("Expected retained Evidence");
    const bytes = await readFile(persisted.path);
    expect(bytes.equals(Buffer.from(JSON.stringify(retained), "utf8"))).toBe(
      true,
    );
    expect(bytes.byteLength).toBe(persisted.bytes);
    expect(bytes.byteLength).toBeGreaterThan(delivery.resultBudgetBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      persisted.sha256,
    );
    const saved = toolContract("procedure_pseudo_code").outputSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    expect(parseEvidence(saved)).toEqual(saved);
    expect(saved.normalized_result).toBe(payload);

    expect(persisted.message).toContain(`saved to: ${persisted.path}`);
    expect(persisted.message).toContain(
      `Evidence ${retained.evidence_id} is retained in this session`,
    );
    expect(persisted.preview_truncated).toBe(true);
    expect(Buffer.byteLength(persisted.preview)).toBeLessThanOrEqual(
      PERSISTED_RESULT_PREVIEW_BYTES,
    );
    expect(bytes.toString("utf8").startsWith(persisted.preview)).toBe(true);
    expect(persisted.preview.length).toBeGreaterThan(
      PERSISTED_RESULT_PREVIEW_BYTES - 4,
    );

    // Owner-only file in an owner-only, store-owned directory.
    const directory = dirname(persisted.path);
    expect(dirname(directory)).toBe(call.parent);
    if (process.platform !== "win32") {
      expect((await stat(persisted.path)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(directory)).toEqual([
      persisted.path.slice(directory.length + 1),
    ]);
    expect(call.store.usedBytes).toBe(persisted.bytes);

    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    if (call.outputSchema === undefined)
      throw new Error("Missing advertised output schema");
    const validate = ajv.compile(jsonObjectSchema.parse(call.outputSchema));
    expect(validate(result.structuredContent)).toBe(true);

    await call.close();
    expect(await readdir(call.parent)).toEqual([]);
  } finally {
    await call.close();
  }
});

it("keeps a result within the response budget inline without creating files", async () => {
  const call = await callPseudoCode("x".repeat(64 * 1024));
  try {
    expect(call.result.isError).not.toBe(true);
    const evidence = toolContract("procedure_pseudo_code").outputSchema.parse(
      call.result.structuredContent,
    );
    expect(evidence.normalized_result).toBe("x".repeat(64 * 1024));
    expect(call.result.structuredContent).not.toHaveProperty(
      "persisted_result",
    );
    expect(await readdir(call.parent)).toEqual([]);
  } finally {
    await call.close();
  }
});

it("persists under the off output-schema profile, which keeps the registered union", async () => {
  const call = await callPseudoCode(
    "x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2),
    1024 * 1024 * 1024,
    true,
  );
  try {
    expect(call.outputSchema).toBeUndefined();
    expect(call.result.isError).not.toBe(true);
    const persisted = persistedOf(call.result.structuredContent);
    expect((await stat(persisted.path)).size).toBe(persisted.bytes);
  } finally {
    await call.close();
  }
});

it("keeps the response-budget error when the complete result cannot be saved", async () => {
  const call = await callPseudoCode(
    "x".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2),
    1024 * 1024,
  );
  try {
    expect(call.result.isError).toBe(true);
    const limits = z
      .object({
        error: z.object({
          code: z.literal("resource_constraint"),
          details: z.object({
            reported_limits: z.object({
              boundary: z.literal("mcp-response"),
              evidence_reference: z.object({ evidence_id: z.string() }),
              persistence_error: z.object({
                code: z.literal("resource_constraint"),
                details: z.object({
                  reported_limits: z.object({
                    boundary: z.literal("mcp-persisted-result"),
                    persisted_result_max_bytes: z.literal(1024 * 1024),
                  }),
                }),
              }),
            }),
          }),
        }),
      })
      .parse(parseMcpToolError(call.result)).error.details.reported_limits;
    expect(call.records.has(limits.evidence_reference.evidence_id)).toBe(true);
    // The staged partial file was removed and no budget stays reserved.
    const [directory] = await readdir(call.parent);
    if (directory === undefined) throw new Error("Expected store directory");
    expect(await readdir(`${call.parent}/${directory}`)).toEqual([]);
    expect(call.store.usedBytes).toBe(0);
  } finally {
    await call.close();
  }
});

it("advertises the persisted alternative in every tool output schema", () => {
  const sample: JsonValue = {
    persisted_result: {
      message: "Output too large. Full output saved to: /tmp/result.json.",
      path: "/tmp/result.json",
      bytes: 11_000_000,
      sha256: "a".repeat(64),
      preview: "{",
      preview_truncated: true,
      evidence_id: `ev_${"b".repeat(64)}`,
    },
  };
  const persistedBranch = (schema: Record<string, unknown>) =>
    z
      .object({ anyOf: z.array(z.record(z.string(), z.unknown())) })
      .parse(schema)
      .anyOf.filter(
        (branch) =>
          z
            .object({ properties: z.object({ persisted_result: z.unknown() }) })
            .safeParse(branch).success,
      );
  let shared: unknown;
  const advertisedByName = new Map<string, Record<string, unknown>>();
  for (const contract of TOOL_CONTRACTS) {
    const registered = toolOutputSchemaWithMetadata(contract);
    expect(registered.safeParse(sample).success, contract.name).toBe(true);
    const advertised = registered["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    advertisedByName.set(contract.name, advertised);
    expect(advertised.type, contract.name).toBe("object");
    const [branch, ...extra] = persistedBranch(advertised);
    expect(extra, contract.name).toEqual([]);
    shared ??= branch;
    expect(branch, contract.name).toEqual(shared);
  }
  // Compile complete advertised schemas for representative large results.
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    addUsedSchema: false,
  });
  for (const name of [
    "procedure_pseudo_code",
    "analyze_javascript_application",
    "trace_application_feature",
    "get_evidence_bundle",
  ]) {
    const advertised = advertisedByName.get(name);
    if (advertised === undefined) throw new Error(`Missing ${name}`);
    try {
      const validate = ajv.compile(advertised);
      expect(validate(sample), name).toBe(true);
      expect(
        validate({ persisted_result: { path: "/tmp/result.json" } }),
        name,
      ).toBe(false);
    } finally {
      ajv.removeSchema();
    }
  }
});
