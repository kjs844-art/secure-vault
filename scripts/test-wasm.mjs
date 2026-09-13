import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const demo = process.argv.includes('--demo');
const folder = demo ? 'vault-wasm-demo' : 'vault-wasm';
let checks = 0;
let archiveRejections = 0;
let catalogsVerified = 0;

function check(condition) {
  checks++;
  // Boolean-only assertions keep private display metadata out of failure logs.
  assert.ok(condition, 'WASM_RUNTIME_CHECK_FAILED');
}

function expectCode(operation, expected) {
  let code;
  let returned;
  try { returned = operation(); } catch (error) { code = error; }
  finally {
    if (returned && typeof returned.free === 'function') {
      returned.lock();
      returned.free();
    }
  }
  check(code === expected);
}

const rowGetters = ['itemName', 'providerName', 'credentialType', 'status',
  'connectionCount', 'secretFieldCount', 'mcpConnectionCount'];
const connectionGetters = ['connectionLabel', 'connectionType'];

function verifyCatalog(catalog, previousRows) {
  const rows = [];
  try {
    check(catalog.isLocked() === false);
    check(catalog.length() === 3);
    const labels = [[], ['Example MCP'], ['Example MCP', 'Example CLI', 'Example CI']];
    const types = [[], ['mcp_server'], ['mcp_server', 'cli', 'ci_cd']];
    for (let ref = 0; ref < 3; ref++) {
      check(catalog.itemName(ref) === 'Example Workshop API Credential');
      check(catalog.providerName(ref) === 'Example AI Workshop');
      check(catalog.credentialType(ref) === 'api_key');
      check(catalog.status(ref) === 'active');
      check(catalog.connectionCount(ref) === [0, 1, 3][ref]);
      check(catalog.secretFieldCount(ref) === [1, 1, 2][ref]);
      check(catalog.mcpConnectionCount(ref) === [0, 1, 1][ref]);
      const row = rowGetters.map((name) => catalog[name](ref));
      for (let index = 0; index < labels[ref].length; index++) {
        check(catalog.connectionLabel(ref, index) === labels[ref][index]);
        check(catalog.connectionType(ref, index) === types[ref][index]);
        row.push(catalog.connectionLabel(ref, index), catalog.connectionType(ref, index));
      }
      rows.push(row);
      if (previousRows) {
        check(row.length === previousRows[ref].length);
        check(row.every((value, index) => value === previousRows[ref][index]));
      }
      for (const name of connectionGetters) {
        expectCode(() => catalog[name](ref, labels[ref].length), 'INVALID_REFERENCE');
      }
    }
    for (const value of [-1, 0.5, 3, 2 ** 32, NaN, Infinity, -Infinity]) {
      for (const name of rowGetters) {
        expectCode(() => catalog[name](value), 'INVALID_REFERENCE');
      }
      for (const name of connectionGetters) {
        expectCode(() => catalog[name](value, 0), 'INVALID_REFERENCE');
        expectCode(() => catalog[name](2, value), 'INVALID_REFERENCE');
      }
    }
    catalog.lock();
    catalog.lock();
    check(catalog.isLocked() === true);
    expectCode(() => catalog.length(), 'LOCKED');
    for (const name of rowGetters) {
      expectCode(() => catalog[name](0), 'LOCKED');
      expectCode(() => catalog[name](NaN), 'LOCKED');
    }
    for (const name of connectionGetters) {
      expectCode(() => catalog[name](0, 0), 'LOCKED');
      expectCode(() => catalog[name](NaN, Infinity), 'LOCKED');
    }
    catalogsVerified++;
    return rows;
  } finally {
    catalog.lock();
    catalog.free();
  }
}

// Test-only frame helpers operate on our generated local synthetic ciphertext.
// They do not import credentials or interact with any third-party target.
function splitFrame(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  check(view.getUint32(8, true) === 1);
  check(view.getUint32(12, true) === 3);
  const envelopes = [];
  let offset = 16;
  for (let index = 0; index < 4; index++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    check(length > 0 && length <= 65_536 && offset + length <= archive.length);
    envelopes.push(archive.slice(offset, offset + length));
    offset += length;
  }
  check(offset === archive.length);
  return envelopes;
}

function frameFrom(archive, envelopes) {
  const length = 16 + envelopes.reduce((total, envelope) => total + 4 + envelope.length, 0);
  const framed = new Uint8Array(length);
  framed.set(archive.subarray(0, 16));
  const view = new DataView(framed.buffer);
  let offset = 16;
  for (const envelope of envelopes) {
    view.setUint32(offset, envelope.length, true);
    offset += 4;
    framed.set(envelope, offset);
    offset += envelope.length;
  }
  return framed;
}

function withU32(archive, offset, value) {
  const altered = archive.slice();
  new DataView(altered.buffer).setUint32(offset, value, true);
  return altered;
}

async function run() {
  const base = new URL('../apps/web/src/generated/' + folder + '/', import.meta.url);
  const api = await import(new URL('vault_client_wasm.js', base).href);
  const bytes = await readFile(new URL('vault_client_wasm_bg.wasm', base));
  const wasmExports = api.initSync({ module: bytes });
  check(typeof api.WasmCatalogV1 === 'function');
  check(typeof api.WasmCatalogV1.from_snapshot === 'undefined');
  for (const name of ['syntheticCatalog', 'createSyntheticArchive', 'openSyntheticArchive']) {
    check(typeof api[name] === (demo ? 'function' : 'undefined'));
    check(typeof wasmExports[name] === (demo ? 'function' : 'undefined'));
  }
  // wasm-bindgen emits an ownership helper. It is not a secret getter;
  // WASM is not a hostile-JavaScript security sandbox.
  const expected = ['constructor', '__destroy_into_raw', 'free', 'length', 'isLocked', 'lock',
    ...rowGetters, ...connectionGetters].sort();
  const actual = Object.getOwnPropertyNames(api.WasmCatalogV1.prototype).sort();
  check(actual.length === expected.length && actual.every((name, index) => name === expected[index]));
  if (!demo) return;

  const rows = verifyCatalog(api.syntheticCatalog());
  const archive = api.createSyntheticArchive();
  check(archive instanceof Uint8Array && archive.length > 0 && archive.length <= 512 * 1_024);
  const original = archive.slice();
  const archiveBuffer = Buffer.from(archive);
  for (const plaintext of [
    'Example Workshop API Credential', 'Example AI Workshop',
    'Example MCP', 'Example CLI', 'Example CI',
    'DEMO_VALUE_ONLY_API_KEY_0001', 'DEMO_VALUE_ONLY_TOKEN_0002',
    'DEMO_VALUE_ONLY_wasm_catalog',
  ]) {
    check(!archiveBuffer.includes(Buffer.from(plaintext)));
  }
  verifyCatalog(api.openSyntheticArchive(archive), rows);
  check(Buffer.from(archive).equals(Buffer.from(original)));

  function reject(input, code) {
    const before = input.slice();
    expectCode(() => api.openSyntheticArchive(input), code);
    check(Buffer.from(input).equals(Buffer.from(before)));
    archiveRejections++;
  }

  for (const end of [0, 7, 8, 11, 12, 15, 16, 19, archive.length - 1]) {
    reject(archive.slice(0, end), 'INVALID_ARCHIVE');
  }
  const trailing = new Uint8Array(archive.length + 1);
  trailing.set(archive);
  reject(trailing, 'INVALID_ARCHIVE');
  const badMagic = archive.slice();
  badMagic[0] ^= 1;
  reject(badMagic, 'INVALID_ARCHIVE');
  reject(withU32(archive, 8, 0), 'INVALID_ARCHIVE');
  reject(withU32(archive, 8, 2), 'UPGRADE_REQUIRED');
  reject(withU32(archive, 12, 2), 'INVALID_ARCHIVE');
  reject(withU32(archive, 16, 0), 'INVALID_ARCHIVE');
  reject(withU32(archive, 16, 65_537), 'LIMITS_EXCEEDED');
  reject(new Uint8Array(512 * 1_024 + 1), 'LIMITS_EXCEEDED');

  const envelopes = splitFrame(archive);
  const futureEnvelope = new Uint8Array([0x81, 0x01]);
  reject(frameFrom(archive, [futureEnvelope, ...envelopes.slice(1)]), 'UPGRADE_REQUIRED');
  reject(frameFrom(archive, [...envelopes.slice(0, 3), futureEnvelope]), 'UPGRADE_REQUIRED');
  reject(frameFrom(archive, [...envelopes.slice(0, 3), new Uint8Array([0])]), 'INVALID_ARCHIVE');
  const badPassword = envelopes[0].slice();
  badPassword[badPassword.length - 1] ^= 1;
  reject(frameFrom(archive, [badPassword, ...envelopes.slice(1)]), 'AUTHENTICATION_FAILED');
  const badLastRecord = archive.slice();
  badLastRecord[badLastRecord.length - 1] ^= 1;
  reject(badLastRecord, 'AUTHENTICATION_FAILED');
  reject(frameFrom(archive, [envelopes[0], envelopes[1], envelopes[1], envelopes[3]]), 'INVALID_ARCHIVE');
  check(Buffer.from(archive).equals(Buffer.from(original)));
}

try {
  await run();
  console.log(JSON.stringify({
    check: 'actual-wasm-runtime', mode: folder, passed: true,
    checks, catalogsVerified, archiveRejections,
  }));
} catch {
  // Do not print thrown values, assertion operands, rows, archive bytes or keys.
  console.log(JSON.stringify({
    check: 'actual-wasm-runtime', mode: folder, passed: false,
    code: 'WASM_RUNTIME_CHECK_FAILED', checks, catalogsVerified, archiveRejections,
  }));
  process.exitCode = 1;
}
