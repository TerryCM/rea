import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { writeTextParts } from "../application/JsonFiles.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { PERSISTED_RESULT_PREVIEW_BYTES } from "../contracts/persistedToolResult.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { EvidenceFileError } from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

/** One completed result saved by the store. */
export interface PersistedToolResultFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
}

/** Where a store creates its private directory; tests select the parent. */
export interface PersistedToolResultStoreOptions {
  readonly maximumBytes: number;
  readonly parent?: string;
}

const PREFIX = "rea-mcp-results-";

/**
 * Owns one MCP session's private directory of complete results that exceed
 * the response budget. The directory is created on first use with owner-only
 * access, each file is published atomically by the shared Evidence writer,
 * the total bytes written are bounded, and close removes the directory after
 * every admitted write settles.
 */
export class PersistedToolResultStore {
  readonly maximumBytes: number;
  readonly #resources: ArtifactResourceScope;
  readonly #parent: string | undefined;
  readonly #active = new Set<Promise<unknown>>();
  #root: Promise<PrivateRuntimeRoot> | undefined;
  #usedBytes = 0;
  #closed = false;

  constructor(
    resources: ArtifactResourceScope,
    options: PersistedToolResultStoreOptions,
  ) {
    this.#resources = resources;
    this.maximumBytes = options.maximumBytes;
    this.#parent = options.parent;
  }

  /** Bytes currently held by published files of this session. */
  get usedBytes(): number {
    return this.#usedBytes;
  }

  /** Write the serialized parts to a new file named for the tool. */
  persist(
    tool: string,
    parts: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<Result<PersistedToolResultFile, AnalysisError>> {
    if (this.#closed)
      return Promise.resolve(
        err(
          new EvidenceFileError("write", "io", {
            userMessage:
              "The MCP session is closing, so the complete result was not saved.",
          }),
        ),
      );
    const running = this.#persist(tool, parts, signal);
    this.#active.add(running);
    return running.finally(() => this.#active.delete(running));
  }

  /** Stop admission, wait for admitted writes, then remove the directory. */
  async close(): Promise<void> {
    this.#closed = true;
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    const root = await this.#root?.catch(() => undefined);
    // PrivateRuntimeRoot does not cache a failed removal, so a later close retries.
    await root?.close();
  }

  async #persist(
    tool: string,
    parts: Iterable<string>,
    signal: AbortSignal | undefined,
  ): Promise<Result<PersistedToolResultFile, AnalysisError>> {
    let root: PrivateRuntimeRoot;
    try {
      this.#root ??= PrivateRuntimeRoot.create({
        prefix: PREFIX,
        ...(this.#parent === undefined ? {} : { parent: this.#parent }),
      });
      root = await this.#root;
    } catch (cause: unknown) {
      // Retry directory creation on the next oversized result.
      this.#root = undefined;
      return err(
        new EvidenceFileError("write", "io", {
          cause,
          userMessage:
            "REA could not create its private directory for oversized MCP results.",
        }),
      );
    }
    // Reserve bytes as they are written so concurrent writes share one bound.
    const metered = new MeteredParts(parts, (bytes) => {
      if (this.#usedBytes + bytes > this.maximumBytes) return false;
      this.#usedBytes += bytes;
      return true;
    });
    const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, "");
    const written = await writeTextParts(
      metered,
      join(root.path, `${tool}-${stamp}-${randomUUID().slice(0, 8)}.json`),
      false,
      this.#resources,
      signal === undefined ? undefined : { signal, operation: tool },
    );
    if (!written.ok) this.#usedBytes -= metered.bytes;
    if (metered.exceeded)
      return err(
        new AnalysisResourceConstraintError(
          tool,
          "transport",
          `The complete result exceeds this MCP session's remaining persisted-result budget of ${String(this.maximumBytes - this.#usedBytes)} bytes. Raise REA_MCP_PERSISTED_RESULT_MAX_BYTES or restart the MCP session to release earlier files.`,
          {
            boundary: "mcp-persisted-result",
            persisted_result_max_bytes: this.maximumBytes,
            persisted_result_used_bytes: this.#usedBytes,
          },
        ),
      );
    if (!written.ok) return written;
    return ok({
      path: written.value.path,
      bytes: written.value.bytes,
      sha256: metered.sha256(),
      preview: metered.preview,
      previewTruncated: metered.previewTruncated,
    });
  }
}

/**
 * Hash, preview and bound the exact parts the writer consumes. Exceeding the
 * byte bound throws inside the writer, which removes its staged file.
 */
class MeteredParts implements Iterable<string> {
  readonly #hash = createHash("sha256");
  #previewBytes = 0;
  /** Bytes reserved for parts already handed to the writer. */
  bytes = 0;
  preview = "";
  previewTruncated = false;
  exceeded = false;

  constructor(
    private readonly parts: Iterable<string>,
    private readonly reserve: (bytes: number) => boolean,
  ) {}

  sha256(): string {
    return this.#hash.digest("hex");
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const part of this.parts) {
      const bytes = Buffer.byteLength(part);
      if (!this.reserve(bytes)) {
        this.exceeded = true;
        throw new Error("Persisted result budget exceeded");
      }
      this.bytes += bytes;
      this.#hash.update(part, "utf8");
      this.#appendPreview(part);
      yield part;
    }
  }

  #appendPreview(part: string): void {
    if (this.previewTruncated || part.length === 0) return;
    // Iterate code points so the preview never splits a UTF-8 sequence.
    for (const character of part) {
      const bytes = Buffer.byteLength(character);
      if (this.#previewBytes + bytes > PERSISTED_RESULT_PREVIEW_BYTES) {
        this.previewTruncated = true;
        return;
      }
      this.preview += character;
      this.#previewBytes += bytes;
    }
  }
}
