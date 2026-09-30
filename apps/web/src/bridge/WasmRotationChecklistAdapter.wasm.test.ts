import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import init, {
  createSyntheticArchive,
  inspectSyntheticRotationChecklist,
  WasmRotationChecklistV1,
} from "../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmRotationChecklistAdapter } from "./WasmRotationChecklistAdapter";

describe("rotation checklist actual-WASM adapter boundary", { concurrent: false }, () => {
  beforeAll(async () => {
    const bytes = await readFile(new URL(
      "../generated/vault-wasm-demo/vault_client_wasm_bg.wasm",
      import.meta.url,
    ));
    await init({ module_or_path: new Uint8Array(bytes) });
  }, 30_000);

  afterEach(() => { vi.restoreAllMocks(); });

  it("releases the authenticated WASM handle before publishing a frozen projection", async () => {
    const lock = vi.spyOn(WasmRotationChecklistV1.prototype, "lock");
    const free = vi.spyOn(WasmRotationChecklistV1.prototype, "free");
    const archive = createSyntheticArchive();
    const original = archive.slice();
    const adapter = new WasmRotationChecklistAdapter(
      () => inspectSyntheticRotationChecklist(
        archive,
        1,
        true, false, false,
        false, false, false,
        0,
      ),
    );

    try {
      const result = await adapter.load();
      expect(result).toEqual({
        generation: "initial_0001",
        readinessState: "ready",
        entries: [{ fixture: "mcp", requiredForCutover: true }],
        remainingRequired: 0,
        remainingOptional: 0,
      });
      expect(adapter.checklist).toBe(result);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.entries)).toBe(true);
      expect(Object.isFrozen(result.entries[0])).toBe(true);
      expect(archive).toEqual(original);
      expect(lock).toHaveBeenCalledOnce();
      expect(free).toHaveBeenCalledOnce();
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(free.mock.invocationCallOrder[0]!);
    } finally {
      adapter.dispose();
    }
  }, 30_000);
});
