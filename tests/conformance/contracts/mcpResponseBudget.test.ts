import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import {
  DEFAULT_PERSISTED_RESULT_MAX_BYTES,
  parseMcpPersistedResultBudget,
} from "../../../src/config/mcpPersistedResultBudget.js";
import { parseMcpResponseBudget } from "../../../src/config/mcpResponseBudget.js";

describe("MCP response budget configuration", () => {
  it("requires the override to accommodate the pinned transport's default frames", () => {
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE)).ok,
    ).toBe(true);
    expect(
      parseMcpResponseBudget(String(STDIO_DEFAULT_MAX_BUFFER_SIZE - 1)).ok,
    ).toBe(false);
  });

  it.each(["", "1.5", "1e8", " 10485760", "9007199254740992"])(
    "rejects malformed or unusable budgets: %j",
    (value) => {
      const parsed = parseMcpResponseBudget(value);
      if (parsed.ok) throw new Error("Expected invalid budget");
      expect(parsed.error.message).toContain("REA_MCP_MAX_RESPONSE_BYTES");
    },
  );
});

describe("MCP persisted-result budget configuration", () => {
  it("defaults to 4 GiB and accepts zero to disable persistence", () => {
    expect(parseMcpPersistedResultBudget(undefined)).toEqual({
      ok: true,
      value: DEFAULT_PERSISTED_RESULT_MAX_BYTES,
    });
    expect(DEFAULT_PERSISTED_RESULT_MAX_BYTES).toBe(4 * 1024 * 1024 * 1024);
    expect(parseMcpPersistedResultBudget("0")).toEqual({ ok: true, value: 0 });
  });

  it.each(["", "-1", "01", "1.5", "1e8", " 1024", "9007199254740992"])(
    "rejects malformed budgets: %j",
    (value) => {
      const parsed = parseMcpPersistedResultBudget(value);
      if (parsed.ok) throw new Error("Expected invalid budget");
      expect(parsed.error.message).toContain(
        "REA_MCP_PERSISTED_RESULT_MAX_BYTES",
      );
    },
  );
});
