import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_SYNTHETIC_SEMANTICS,
  SYNTHETIC_ARCHIVE_MAGIC,
  SYNTHETIC_ARCHIVE_MAX_BYTES,
  assertKnownSyntheticSemantics,
  deriveNegativeArchives,
  inspectSyntheticArchive,
  parseBackupRoundtripArgs,
} from "./backup-roundtrip-contract.mjs";

function archive({ version = 4, count = 3, revisions = 3, staged = 0, length = 64 } = {}) {
  const bytes = new Uint8Array(length);
  bytes.set(SYNTHETIC_ARCHIVE_MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, version, true);
  view.setUint32(12, count, true);
  if (version >= 3 && length >= 20) view.setUint32(16, revisions, true);
  if (version === 4 && length >= 24) view.setUint32(20, staged, true);
  for (let index = version === 4 ? 24 : version === 3 ? 20 : 16; index < length; index += 1) {
    bytes[index] = (index * 17) & 0xff;
  }
  return bytes;
}

test("arguments require the synthetic gate and one supported installed-browser channel", () => {
  assert.deepEqual(parseBackupRoundtripArgs(["--synthetic-only"]), { channel: "chrome", preflight: false });
  assert.deepEqual(parseBackupRoundtripArgs(["--channel=msedge", "--preflight", "--synthetic-only"]),
    { channel: "msedge", preflight: true });
  for (const args of [[], ["--preflight"], ["--synthetic-only", "--synthetic-only"],
    ["--synthetic-only", "--channel=firefox"],
    ["--synthetic-only", "--channel=chrome", "--channel=msedge"],
    ["--synthetic-only", "--unknown"]]) {
    assert.throws(() => parseBackupRoundtripArgs(args), /BACKUP_ROUNDTRIP_ARGUMENTS/);
  }
});

test("archive inspection enforces exact type, bounded size and supported headers", () => {
  assert.deepEqual(inspectSyntheticArchive(archive()), {
    bytes: 64, version: 4, count: 3, revisions: 3, staged: 0, headerBytes: 24,
  });
  assert.throws(() => inspectSyntheticArchive(Buffer.from(archive())), /ARCHIVE_TYPE/);
  assert.throws(() => inspectSyntheticArchive(new Uint8Array(15)), /ARCHIVE_SIZE/);
  assert.throws(() => inspectSyntheticArchive(new Uint8Array(SYNTHETIC_ARCHIVE_MAX_BYTES + 1)), /ARCHIVE_SIZE/);
  const badMagic = archive(); badMagic[0] ^= 1;
  assert.throws(() => inspectSyntheticArchive(badMagic), /ARCHIVE_MAGIC/);
  assert.throws(() => inspectSyntheticArchive(archive({ version: 5 })), /ARCHIVE_VERSION/);
  assert.throws(() => inspectSyntheticArchive(archive({ version: 4, count: 2 })), /ARCHIVE_COUNT/);
  assert.throws(() => inspectSyntheticArchive(archive({ version: 4, revisions: 2 })), /ARCHIVE_REVISIONS/);
  assert.throws(() => inspectSyntheticArchive(archive({ version: 4, revisions: 500, staged: 13 })), /ARCHIVE_STAGED/);
  assert.throws(() => inspectSyntheticArchive(archive({ version: 4, length: 24 })), /ARCHIVE_BODY/);
});

test("negative archives are independent bounded copies and never mutate their source", () => {
  const input = archive();
  const original = new Uint8Array(input);
  const derived = deriveNegativeArchives(input);
  assert.deepEqual(input, original);
  assert.notStrictEqual(derived.malformed.buffer, input.buffer);
  assert.notStrictEqual(derived.corrupted.buffer, input.buffer);
  assert.notStrictEqual(derived.future.buffer, input.buffer);
  assert.equal(derived.malformed.byteLength, input.byteLength);
  assert.equal(derived.corrupted.byteLength, input.byteLength);
  assert.equal(derived.future.byteLength, input.byteLength);
  assert.notEqual(derived.malformed[0], input[0]);
  assert.equal(derived.corrupted.at(-1), input.at(-1) ^ 1);
  assert.equal(new DataView(derived.future.buffer).getUint32(8, true), 5);
  assert.throws(() => inspectSyntheticArchive(derived.malformed), /ARCHIVE_MAGIC/);
  assert.throws(() => inspectSyntheticArchive(derived.future), /ARCHIVE_VERSION/);
  assert.deepEqual(inspectSyntheticArchive(derived.corrupted), inspectSyntheticArchive(input));
});

test("fixed semantics reject a wrong source and destination even when both are equal", () => {
  assert.strictEqual(assertKnownSyntheticSemantics(EXPECTED_SYNTHETIC_SEMANTICS), EXPECTED_SYNTHETIC_SEMANTICS);
  const wrongSource = structuredClone(EXPECTED_SYNTHETIC_SEMANTICS);
  wrongSource[0].providerName = "Wrong but self-consistent provider";
  const wrongDestination = structuredClone(wrongSource);
  assert.deepEqual(wrongDestination, wrongSource);
  assert.throws(() => assertKnownSyntheticSemantics(wrongSource), /BACKUP_ROUNDTRIP_SEMANTICS/);
  assert.throws(() => assertKnownSyntheticSemantics(wrongDestination), /BACKUP_ROUNDTRIP_SEMANTICS/);
});
