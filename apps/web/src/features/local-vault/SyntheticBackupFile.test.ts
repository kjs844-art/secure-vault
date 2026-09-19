import { describe, expect, it, vi } from "vitest";
import { readSyntheticBackupFile } from "./SyntheticBackupFile";

describe("synthetic backup bounded file reader", () => {
  it("reads only on explicit invocation and does not depend on filename or MIME", async () => {
    const bytes = new Uint8Array(32).fill(71);
    const blob = new Blob([bytes], { type: "text/plain" });
    const read = vi.spyOn(blob, "arrayBuffer");
    expect(read).not.toHaveBeenCalled();
    expect(await readSyntheticBackupFile(blob)).toEqual(bytes);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([0, 15, 524289, Number.NaN, -1, 3.5])("rejects size %s before reading any bytes", async (size) => {
    const read = vi.fn().mockResolvedValue(new ArrayBuffer(32));
    const blob = { size, arrayBuffer: read } as unknown as Blob;
    await expect(readSyntheticBackupFile(blob)).rejects.toMatchObject({
      code: size > 524288 ? "LIMIT_EXCEEDED" : "INVALID_BACKUP",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts exactly the maximum allocation size", async () => {
    const file = new Blob([new Uint8Array(524288)]);
    expect((await readSyntheticBackupFile(file)).byteLength).toBe(524288);
  });

  it("rejects a result whose size differs from the declared file size", async () => {
    const file = { size: 32, arrayBuffer: async () => new ArrayBuffer(33) } as Blob;
    await expect(readSyntheticBackupFile(file)).rejects.toMatchObject({ code: "INVALID_BACKUP" });
  });

  it.each([null, "DEMO_PRIVATE_FILE_CONTENT", new Uint8Array(32)])("rejects non-ArrayBuffer results", async (value) => {
    const file = { size: 32, arrayBuffer: async () => value } as unknown as Blob;
    await expect(readSyntheticBackupFile(file)).rejects.toMatchObject({ code: "INVALID_BACKUP" });
  });

  it("does not propagate a file access failure or filename", async () => {
    const file = { size: 32, arrayBuffer: async () => { throw new Error("DEMO_PRIVATE_FILENAME"); } } as unknown as Blob;
    const error = await readSyntheticBackupFile(file).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "INVALID_BACKUP" });
    expect(String(error)).not.toContain("DEMO_PRIVATE_FILENAME");
  });

  it("normalizes a throwing size accessor", async () => {
    const read = vi.fn();
    const file = { get size() { throw new Error("DEMO_PRIVATE_FILENAME"); }, arrayBuffer: read } as unknown as Blob;
    await expect(readSyntheticBackupFile(file)).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    expect(read).not.toHaveBeenCalled();
  });
});
