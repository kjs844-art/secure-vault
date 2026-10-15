import { MAX_SYNTHETIC_ARCHIVE_BYTES } from "../../storage/SyntheticCiphertextStore";
import { SyntheticBackupError } from "./SyntheticVaultBackup";

/** Check size BEFORE allocation; filename/MIME are hints, never authentication. */
export async function readSyntheticBackupFile(file: Blob): Promise<Uint8Array> {
  let size: number;
  try { size = file.size; } catch { throw new SyntheticBackupError("INVALID_BACKUP"); }
  if (!Number.isSafeInteger(size) || size < 16) throw new SyntheticBackupError("INVALID_BACKUP");
  if (size > MAX_SYNTHETIC_ARCHIVE_BYTES) throw new SyntheticBackupError("LIMIT_EXCEEDED");
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new SyntheticBackupError("INVALID_BACKUP"); }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  return new Uint8Array(buffer);
}
