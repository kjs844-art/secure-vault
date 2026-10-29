export const SYNTHETIC_ARCHIVE_MAGIC = Uint8Array.from([75, 65, 84, 76, 68, 69, 77, 79]);
export const SYNTHETIC_ARCHIVE_MAX_BYTES = 512 * 1024;
export const SYNTHETIC_ARCHIVE_MIN_BYTES = 16;
export const SYNTHETIC_BACKUP_FILENAME = "keyatlas-synthetic-v1.katldemo";

const CHANNELS = new Set(["chrome", "msedge"]);

export const EXPECTED_SYNTHETIC_SEMANTICS = Object.freeze([
  Object.freeze({ reference: 0, example: "예시 1", providerName: "Example AI Workshop",
    itemName: "Example Workshop API Credential", credentialLabel: "API 키", statusLabel: "사용 중",
    secretFieldCount: 1, connectionCount: 0,
    issuer: Object.freeze({ account: "demo-account", organization: "기록 없음", project: "demo-project", environment: "demo" }),
    connections: Object.freeze([]) }),
  Object.freeze({ reference: 1, example: "예시 2", providerName: "Example AI Workshop",
    itemName: "Example Workshop API Credential", credentialLabel: "API 키", statusLabel: "사용 중",
    secretFieldCount: 1, connectionCount: 1,
    issuer: Object.freeze({ account: "demo-account", organization: "기록 없음", project: "demo-project", environment: "demo" }),
    connections: Object.freeze([Object.freeze({ label: "Example MCP", consumerTypeLabel: "MCP 서버" })]) }),
  Object.freeze({ reference: 2, example: "예시 3", providerName: "Example AI Workshop",
    itemName: "Example Workshop API Credential", credentialLabel: "API 키", statusLabel: "사용 중",
    secretFieldCount: 2, connectionCount: 3,
    issuer: Object.freeze({ account: "demo-account", organization: "기록 없음", project: "demo-project", environment: "demo" }),
    connections: Object.freeze([
      Object.freeze({ label: "Example MCP", consumerTypeLabel: "MCP 서버" }),
      Object.freeze({ label: "Example CLI", consumerTypeLabel: "CLI 도구" }),
      Object.freeze({ label: "Example CI", consumerTypeLabel: "CI/CD" }),
    ]) }),
]);
const EXPECTED_SYNTHETIC_SEMANTICS_JSON = JSON.stringify(EXPECTED_SYNTHETIC_SEMANTICS);

export function assertKnownSyntheticSemantics(value) {
  if (JSON.stringify(value) !== EXPECTED_SYNTHETIC_SEMANTICS_JSON) {
    throw new TypeError("BACKUP_ROUNDTRIP_SEMANTICS");
  }
  return value;
}

export function parseBackupRoundtripArgs(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("BACKUP_ROUNDTRIP_ARGUMENTS");
  }
  const allowed = new Set(["--synthetic-only", "--preflight", "--channel=chrome", "--channel=msedge"]);
  const channelArguments = args.filter((value) => value.startsWith("--channel="));
  if (!args.includes("--synthetic-only") || new Set(args).size !== args.length
    || channelArguments.length > 1 || args.some((value) => !allowed.has(value))) {
    throw new TypeError("BACKUP_ROUNDTRIP_ARGUMENTS");
  }
  const channel = channelArguments[0]?.slice("--channel=".length) ?? "chrome";
  if (!CHANNELS.has(channel)) throw new TypeError("BACKUP_ROUNDTRIP_ARGUMENTS");
  return Object.freeze({ channel, preflight: args.includes("--preflight") });
}

function exactBytes(value) {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError("BACKUP_ROUNDTRIP_ARCHIVE_TYPE");
  }
  if (value.byteLength < SYNTHETIC_ARCHIVE_MIN_BYTES
    || value.byteLength > SYNTHETIC_ARCHIVE_MAX_BYTES) {
    throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_SIZE");
  }
  return value;
}

export function inspectSyntheticArchive(value) {
  const bytes = exactBytes(value);
  for (let index = 0; index < SYNTHETIC_ARCHIVE_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== SYNTHETIC_ARCHIVE_MAGIC[index]) {
      throw new TypeError("BACKUP_ROUNDTRIP_ARCHIVE_MAGIC");
    }
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = header.getUint32(8, true);
  const count = header.getUint32(12, true);
  if (![1, 2, 3, 4].includes(version)) throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_VERSION");
  if (!Number.isSafeInteger(count) || count < 3 || count > 128 || (version === 1 && count !== 3)) {
    throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_COUNT");
  }
  const headerBytes = version === 4 ? 24 : version === 3 ? 20 : 16;
  if (bytes.byteLength <= headerBytes) throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_BODY");
  let revisions = null;
  let staged = null;
  if (version >= 3) {
    revisions = header.getUint32(16, true);
    if (revisions < count || revisions > 512) throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_REVISIONS");
  }
  if (version === 4) {
    staged = header.getUint32(20, true);
    if (revisions + staged > 512) throw new RangeError("BACKUP_ROUNDTRIP_ARCHIVE_STAGED");
  }
  return Object.freeze({ bytes: bytes.byteLength, version, count, revisions, staged, headerBytes });
}

export function deriveNegativeArchives(value) {
  const descriptor = inspectSyntheticArchive(value);
  const malformed = new Uint8Array(value);
  malformed[0] ^= 0xff;

  const corrupted = new Uint8Array(value);
  corrupted[corrupted.byteLength - 1] ^= 0x01;

  const future = new Uint8Array(value);
  new DataView(future.buffer).setUint32(8, 5, true);

  return Object.freeze({
    malformed,
    corrupted,
    future,
    source: descriptor,
  });
}
