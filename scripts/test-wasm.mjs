import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const demo = process.argv.includes('--demo');
const folder = demo ? 'vault-wasm-demo' : 'vault-wasm';
let checks = 0;
let archiveRejections = 0;
let catalogsVerified = 0;
let registrationsVerified = 0;
let connectionEditsVerified = 0;
let rotationChecklistsVerified = 0;
let rotationCutoversVerified = 0;
let rotationRejections = 0;

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

const issuerGetters = ['issuerAccountIdentifier', 'issuerOrganizationOrWorkspace',
  'issuerProject', 'issuerEnvironment'];
const rowGetters = ['itemName', 'providerName', ...issuerGetters, 'credentialType', 'status',
  'connectionCount', 'secretFieldCount', 'mcpConnectionCount'];
const connectionGetters = ['connectionLabel', 'connectionType'];
const rotationValueGetters = ['generation', 'readinessState', 'entryCount',
  'remainingRequired', 'remainingOptional'];
const rotationEntryGetters = ['entryFixture', 'entryRequiredForCutover'];

function verifyRotationChecklist(checklist, expected, verifyInvalidReferences = false) {
  try {
    check(checklist.isLocked() === false);
    check(checklist.generation() === expected.generation);
    check(checklist.readinessState() === expected.readinessState);
    check(checklist.entryCount() === expected.entries.length);
    check(checklist.remainingRequired() === expected.remainingRequired);
    check(checklist.remainingOptional() === expected.remainingOptional);
    expected.entries.forEach(({ fixture, requiredForCutover }, index) => {
      check(checklist.entryFixture(index) === fixture);
      check(checklist.entryRequiredForCutover(index) === requiredForCutover);
    });
    if (verifyInvalidReferences) {
      for (const value of [-0, -1, 0.5, expected.entries.length, 2 ** 32,
        NaN, Infinity, -Infinity, '0', true, false, null, undefined]) {
        for (const name of rotationEntryGetters) {
          expectCode(() => checklist[name](value), 'INVALID_REFERENCE');
        }
      }
    }
    checklist.lock();
    checklist.lock();
    check(checklist.isLocked() === true);
    for (const name of rotationValueGetters) {
      expectCode(() => checklist[name](), 'LOCKED');
    }
    for (const name of rotationEntryGetters) {
      expectCode(() => checklist[name](0), 'LOCKED');
      expectCode(() => checklist[name](NaN), 'LOCKED');
    }
    rotationChecklistsVerified++;
  } finally {
    checklist.lock();
    checklist.free();
  }
}

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
      check(catalog.issuerAccountIdentifier(ref) === 'demo-account');
      check(catalog.issuerOrganizationOrWorkspace(ref) === undefined);
      check(catalog.issuerOrganizationOrWorkspace(ref) !== null);
      check(catalog.issuerProject(ref) === 'demo-project');
      check(catalog.issuerEnvironment(ref) === 'demo');
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
  const version = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  check(version === 1 ? count === 3 : version === 2 && count >= 3 && count <= 128);
  const envelopes = [];
  let offset = 16;
  for (let index = 0; index < count + 1; index++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    check(length > 0 && length <= 65_536 && offset + length <= archive.length);
    envelopes.push(archive.slice(offset, offset + length));
    offset += length;
  }
  check(offset === archive.length);
  return envelopes;
}

function frameFrom(archive, envelopes, version = new DataView(archive.buffer, archive.byteOffset).getUint32(8, true)) {
  const length = 16 + envelopes.reduce((total, envelope) => total + 4 + envelope.length, 0);
  const framed = new Uint8Array(length);
  framed.set(archive.subarray(0, 16));
  const view = new DataView(framed.buffer);
  view.setUint32(8, version, true);
  view.setUint32(12, envelopes.length - 1, true);
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

function splitHistory(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  check(view.getUint32(8, true) === 3);
  const count = view.getUint32(12, true);
  const revisions = view.getUint32(16, true);
  check(count >= 3 && count <= 128 && revisions >= count && revisions <= 512);
  const envelopes = [];
  let offset = 20;
  for (let index = 0; index <= revisions; index++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    check(length > 0 && length <= 65_536 && offset + length <= archive.length);
    envelopes.push(archive.slice(offset, offset + length));
    offset += length;
  }
  const headOffset = offset;
  const heads = [];
  for (let index = 0; index < count; index++, offset += 4) {
    heads.push(view.getUint32(offset, true));
  }
  check(offset === archive.length && new Set(heads).size === count);
  check(heads.every((head) => head < revisions));
  return { envelopes, heads, headOffset };
}

function verifyRegistrationCatalog(catalog, originalRows, registrations) {
  try {
    check(catalog.length() === 3 + registrations.length);
    for (let ref = 0; ref < 3; ref++) {
      const row = rowGetters.map((name) => catalog[name](ref));
      for (let index = 0; index < catalog.connectionCount(ref); index++) {
        row.push(catalog.connectionLabel(ref, index), catalog.connectionType(ref, index));
      }
      check(row.length === originalRows[ref].length);
      check(row.every((value, index) => value === originalRows[ref][index]));
    }
    registrations.forEach(({ profile, connections }, index) => {
      const ref = 3 + index;
      check(catalog.providerName(ref) === ['Example AI Workshop', 'Example Cloud Lab'][profile]);
      check(catalog.itemName(ref) === ['Example Workshop Registered API Key', 'Example Cloud Lab Registered API Key'][profile]);
      check(catalog.issuerAccountIdentifier(ref) === ['demo-account', 'lab-account'][profile]);
      check(catalog.issuerOrganizationOrWorkspace(ref) === ['demo-workspace', 'lab-workspace'][profile]);
      check(catalog.issuerProject(ref) === ['demo-project', 'lab-project'][profile]);
      check(catalog.issuerEnvironment(ref) === ['demo', 'staging'][profile]);
      check(catalog.credentialType(ref) === 'api_key' && catalog.status(ref) === 'active');
      check(catalog.secretFieldCount(ref) === 1);
      check(catalog.connectionCount(ref) === connections.length);
      check(catalog.mcpConnectionCount(ref) === Number(connections.includes(0)));
      connections.forEach((id, connectionIndex) => {
        check(catalog.connectionLabel(ref, connectionIndex) === ['Example MCP', 'Example CLI', 'Example CI'][id]);
        check(catalog.connectionType(ref, connectionIndex) === ['mcp_server', 'cli', 'ci_cd'][id]);
      });
    });
    catalog.lock();
    expectCode(() => catalog.length(), 'LOCKED');
    for (const name of rowGetters) expectCode(() => catalog[name](3), 'LOCKED');
    catalogsVerified++;
  } finally {
    catalog.lock();
    catalog.free();
  }
}

async function run() {
  const base = new URL('../apps/web/src/generated/' + folder + '/', import.meta.url);
  const api = await import(new URL('vault_client_wasm.js', base).href);
  const bytes = await readFile(new URL('vault_client_wasm_bg.wasm', base));
  const wasmExports = api.initSync({ module: bytes });
  check(typeof api.WasmCatalogV1 === 'function');
  check(typeof api.WasmCatalogV1.from_snapshot === 'undefined');
  for (const name of ['syntheticCatalog', 'createSyntheticArchive', 'openSyntheticArchive',
    'appendSyntheticRegistration', 'editSyntheticConnections',
    'inspectSyntheticRotationChecklist', 'createSyntheticRotationCutover',
    'inspectSyntheticRotationStage', 'createSyntheticRotationStage', 'createSyntheticRotationCutoverFromStage']) {
    check(typeof api[name] === (demo ? 'function' : 'undefined'));
    check(typeof wasmExports[name] === (demo ? 'function' : 'undefined'));
  }
  for (const name of ['inspectSyntheticRotationChecklist', 'createSyntheticRotationCutover']) {
    check(Object.prototype.hasOwnProperty.call(api, name) === demo);
    check(Object.prototype.hasOwnProperty.call(wasmExports, name) === demo);
  }
  check(typeof api.WasmRotationChecklistV1 === (demo ? 'function' : 'undefined'));
  check(Object.prototype.hasOwnProperty.call(api, 'WasmRotationChecklistV1') === demo);
  check(typeof api.WasmRotationStageV1 === (demo ? 'function' : 'undefined'));
  check(Object.prototype.hasOwnProperty.call(api, 'WasmRotationStageV1') === demo);
  // wasm-bindgen emits an ownership helper. It is not a secret getter;
  // WASM is not a hostile-JavaScript security sandbox.
  const expected = ['constructor', '__destroy_into_raw', 'free', 'length', 'isLocked', 'lock',
    ...rowGetters, ...connectionGetters].sort();
  const actual = Object.getOwnPropertyNames(api.WasmCatalogV1.prototype).sort();
  check(actual.length === expected.length && actual.every((name, index) => name === expected[index]));
  for (const denied of ['secretValue', 'secretFields', 'notes', 'consoleUrl', 'recordId',
    'revisionId', 'issuerAccountRef', 'issuerProjectRef', 'configurationReference']) {
    check(typeof api.WasmCatalogV1.prototype[denied] === 'undefined');
  }
  if (!demo) return;

  let directChecklistConstructionRejected = false;
  try { new api.WasmRotationChecklistV1(); }
  catch (error) {
    directChecklistConstructionRejected = error instanceof Error
      && error.message === 'CONSTRUCTOR_DISABLED';
  }
  check(directChecklistConstructionRejected);

  // wasm-bindgen emits the same ownership helper used by WasmCatalogV1. Apart
  // from that generated helper, the checklist surface is the exact allowlist.
  const expectedRotationPrototype = ['constructor', '__destroy_into_raw', 'free', 'isLocked',
    'lock', ...rotationValueGetters, ...rotationEntryGetters].sort();
  const actualRotationPrototype = Object.getOwnPropertyNames(
    api.WasmRotationChecklistV1.prototype,
  ).sort();
  check(actualRotationPrototype.length === expectedRotationPrototype.length
    && actualRotationPrototype.every((name, index) => name === expectedRotationPrototype[index]));
  for (const denied of ['secretValue', 'secretFields', 'rawEvidence', 'evidence',
    'verificationEvidence', 'supersededRevocationEvidence', 'userConfirmed',
    'providerVerified', 'record', 'recordId', 'revision', 'revisionId',
    'parentRevisionId', 'expectedRevisionId', 'archiveBytes']) {
    check(typeof api.WasmRotationChecklistV1.prototype[denied] === 'undefined');
  }

  const rows = verifyCatalog(api.syntheticCatalog());
  const archive = api.createSyntheticArchive();
  check(archive instanceof Uint8Array && archive.length > 0 && archive.length <= 512 * 1_024);
  const original = archive.slice();
  const syntheticPlaintextMarkers = [
    'Example Workshop API Credential', 'Example AI Workshop',
    'Example MCP', 'Example CLI', 'Example CI',
    'DEMO_VALUE_ONLY_API_KEY_0001', 'DEMO_VALUE_ONLY_TOKEN_0002',
    'DEMO_VALUE_ONLY_ROTATED_API_KEY_0002',
    'DEMO_VALUE_ONLY_ROTATED_API_KEY_0003',
    'DEMO_VALUE_ONLY_wasm_catalog',
  ];
  function verifyNoSyntheticPlaintext(input) {
    const buffer = Buffer.from(input);
    for (const plaintext of syntheticPlaintextMarkers) {
      check(!buffer.includes(Buffer.from(plaintext)));
    }
  }
  verifyNoSyntheticPlaintext(archive);
  verifyCatalog(api.openSyntheticArchive(archive), rows);
  check(Buffer.from(archive).equals(Buffer.from(original)));

  const pendingRotationArgs = [1, false, false, false, false, false, false, 0];
  const userReadyRotationArgs = [1, true, false, false, false, false, false, 0];
  const providerReadyRotationArgs = [1, false, false, false, true, false, false, 1];

  function inspectRotation(input, args) {
    return api.inspectSyntheticRotationChecklist(input, ...args);
  }

  function cutoverRotation(input, args) {
    return api.createSyntheticRotationCutover(input, ...args);
  }

  function rejectRotationArgs(input, args, code = 'INVALID_ARCHIVE') {
    const before = input.slice();
    expectCode(() => inspectRotation(input, args), code);
    check(Buffer.from(input).equals(Buffer.from(before)));
    expectCode(() => cutoverRotation(input, args), code);
    check(Buffer.from(input).equals(Buffer.from(before)));
    rotationRejections++;
  }

  const beforePendingInspection = archive.slice();
  verifyRotationChecklist(inspectRotation(archive, pendingRotationArgs), {
    generation: 'initial_0001', readinessState: 'required_pending',
    remainingRequired: 1, remainingOptional: 0,
    entries: [{ fixture: 'mcp', requiredForCutover: true }],
  }, true);
  check(Buffer.from(archive).equals(Buffer.from(beforePendingInspection)));
  const beforePendingCutover = archive.slice();
  expectCode(() => cutoverRotation(archive, pendingRotationArgs), 'INVALID_ARCHIVE');
  check(Buffer.from(archive).equals(Buffer.from(beforePendingCutover)));
  rotationRejections++;

  const beforeReadyInspection = archive.slice();
  verifyRotationChecklist(inspectRotation(archive, userReadyRotationArgs), {
    generation: 'initial_0001', readinessState: 'ready',
    remainingRequired: 0, remainingOptional: 0,
    entries: [{ fixture: 'mcp', requiredForCutover: true }],
  });
  check(Buffer.from(archive).equals(Buffer.from(beforeReadyInspection)));

  const optionalRotationArgs = [2, false, false, false, false, false, false, 0];
  const beforeOptionalInspection = archive.slice();
  verifyRotationChecklist(inspectRotation(archive, optionalRotationArgs), {
    generation: 'initial_0001', readinessState: 'ready',
    remainingRequired: 0, remainingOptional: 3,
    entries: [
      { fixture: 'mcp', requiredForCutover: false },
      { fixture: 'cli', requiredForCutover: false },
      { fixture: 'ci', requiredForCutover: false },
    ],
  });
  check(Buffer.from(archive).equals(Buffer.from(beforeOptionalInspection)));

  // The first cutover migrates a v1 genesis archive directly to v3 while
  // preserving every existing envelope and changing only the selected head.
  const initialEnvelopes = splitFrame(archive);
  const beforeFirstCutover = archive.slice();
  const rotated0002 = cutoverRotation(archive, userReadyRotationArgs);
  check(rotated0002 instanceof Uint8Array && rotated0002.length <= 512 * 1_024);
  verifyNoSyntheticPlaintext(rotated0002);
  check(Buffer.from(archive).equals(Buffer.from(beforeFirstCutover)));
  const parsed0002 = splitHistory(rotated0002);
  check(parsed0002.envelopes.length === initialEnvelopes.length + 1);
  initialEnvelopes.forEach((envelope, index) => {
    check(Buffer.from(envelope).equals(Buffer.from(parsed0002.envelopes[index])));
  });
  check(parsed0002.heads[0] === 0 && parsed0002.heads[2] === 2);
  check(parsed0002.heads[1] === parsed0002.envelopes.length - 2);
  verifyRotationChecklist(inspectRotation(rotated0002, userReadyRotationArgs), {
    generation: 'rotated_0002', readinessState: 'ready',
    remainingRequired: 0, remainingOptional: 0,
    entries: [{ fixture: 'mcp', requiredForCutover: true }],
  });
  rotationCutoversVerified++;

  const beforeSecondCutover = rotated0002.slice();
  const terminal0003 = cutoverRotation(rotated0002, providerReadyRotationArgs);
  check(terminal0003 instanceof Uint8Array && terminal0003.length <= 512 * 1_024);
  verifyNoSyntheticPlaintext(terminal0003);
  check(Buffer.from(rotated0002).equals(Buffer.from(beforeSecondCutover)));
  const parsed0003 = splitHistory(terminal0003);
  check(parsed0003.envelopes.length === parsed0002.envelopes.length + 1);
  parsed0002.envelopes.forEach((envelope, index) => {
    check(Buffer.from(envelope).equals(Buffer.from(parsed0003.envelopes[index])));
  });
  check(parsed0003.heads[0] === 0 && parsed0003.heads[2] === 2);
  check(parsed0003.heads[1] === parsed0003.envelopes.length - 2);
  verifyRotationChecklist(inspectRotation(terminal0003, pendingRotationArgs), {
    generation: 'terminal_0003', readinessState: 'terminal',
    remainingRequired: 0, remainingOptional: 0,
    entries: [{ fixture: 'mcp', requiredForCutover: true }],
  });
  rotationCutoversVerified++;

  const beforeRejectedThirdCutover = terminal0003.slice();
  expectCode(() => cutoverRotation(terminal0003, userReadyRotationArgs), 'INVALID_ARCHIVE');
  check(Buffer.from(terminal0003).equals(Buffer.from(beforeRejectedThirdCutover)));
  rotationRejections++;

  for (const invalid of [-0, -1, 0.5, 3, 2 ** 32, NaN, Infinity, -Infinity,
    '1', true, false, null, undefined]) {
    const args = pendingRotationArgs.slice();
    args[0] = invalid;
    rejectRotationArgs(archive, args);
  }
  for (let argument = 1; argument <= 6; argument++) {
    for (const invalid of [0, 1, 'true', null, undefined, NaN]) {
      const args = pendingRotationArgs.slice();
      args[argument] = invalid;
      rejectRotationArgs(archive, args);
    }
  }
  for (const invalid of [-0, -1, 0.5, 2, 2 ** 32, NaN, Infinity, -Infinity,
    true, false, '0', null, undefined]) {
    const args = pendingRotationArgs.slice();
    args[7] = invalid;
    rejectRotationArgs(archive, args);
  }
  for (let fixture = 0; fixture < 3; fixture++) {
    const args = [2, false, false, false, false, false, false, 0];
    args[1 + fixture] = true;
    args[4 + fixture] = true;
    rejectRotationArgs(archive, args);
  }
  check(Buffer.from(archive).equals(Buffer.from(original)));

  function reject(input, code) {
    const before = input.slice();
    expectCode(() => api.openSyntheticArchive(input), code);
    expectCode(() => api.appendSyntheticRegistration(input, 0, 0, new Float64Array()), code);
    expectCode(() => api.editSyntheticConnections(input, 0, new Float64Array()), code);
    // Every malformed/corrupt archive fixture must also fail through the new
    // rotation boundaries. This prevents a parser/authentication regression
    // from being hidden by coverage of only the older archive operations.
    expectCode(() => inspectRotation(input, [0, false, false, false,
      false, false, false, 0]), code);
    expectCode(() => cutoverRotation(input, [0, false, false, false,
      false, false, false, 0]), code);
    check(Buffer.from(input).equals(Buffer.from(before)));
    archiveRejections++;
    rotationRejections++;
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
  reject(withU32(archive, 8, 5), 'UPGRADE_REQUIRED');
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

  let current = archive;
  const registrations = [];
  for (const selection of [{ profile: 0, connections: [] }, { profile: 1, connections: [0] },
    { profile: 0, connections: [2, 0, 1] }]) {
    const before = current.slice();
    const previousEnvelopes = splitFrame(current);
    const next = api.appendSyntheticRegistration(current, selection.profile, 0, new Float64Array(selection.connections));
    check(next instanceof Uint8Array && next.length <= 512 * 1_024);
    check(new DataView(next.buffer, next.byteOffset).getUint32(8, true) === 2);
    check(Buffer.from(current).equals(Buffer.from(before)));
    const nextEnvelopes = splitFrame(next);
    check(nextEnvelopes.length === previousEnvelopes.length + 1);
    previousEnvelopes.forEach((envelope, index) => {
      check(Buffer.from(envelope).equals(Buffer.from(nextEnvelopes[index])));
    });
    for (const plaintext of ['DEMO_VALUE_ONLY_API_KEY_0001', 'DEMO_VALUE_ONLY_wasm_catalog',
      'Example Workshop Registered API Key', 'Example Cloud Lab Registered API Key']) {
      check(!Buffer.from(next).includes(Buffer.from(plaintext)));
    }
    registrations.push(selection);
    verifyRegistrationCatalog(api.openSyntheticArchive(next), rows, registrations);
    current = next;
    registrationsVerified++;
  }

  function rejectSelection(profile, credential, connections, code = 'INVALID_ARCHIVE') {
    const before = current.slice();
    expectCode(() => api.appendSyntheticRegistration(current, profile, credential, new Float64Array(connections)), code);
    check(Buffer.from(current).equals(Buffer.from(before)));
    archiveRejections++;
  }
  for (const invalid of [-1, 0.5, 2 ** 32, NaN, Infinity, -Infinity]) {
    rejectSelection(invalid, 0, []);
    rejectSelection(0, invalid, []);
    rejectSelection(0, 0, [invalid]);
  }
  rejectSelection(2, 0, []);
  rejectSelection(0, 1, []);
  rejectSelection(0, 0, [3]);
  rejectSelection(0, 0, [0, 0]);
  rejectSelection(0, 0, [0, 1, 2, 0], 'LIMITS_EXCEEDED');
  reject(withU32(current, 8, 1), 'INVALID_ARCHIVE');
  reject(withU32(current, 8, 5), 'UPGRADE_REQUIRED');
  reject(withU32(current, 12, 2), 'INVALID_ARCHIVE');
  reject(withU32(current, 12, 129), 'LIMITS_EXCEEDED');
  const corruptV2 = current.slice();
  corruptV2[corruptV2.length - 1] ^= 1;
  reject(corruptV2, 'AUTHENTICATION_FAILED');
  const v2Envelopes = splitFrame(current);
  reject(frameFrom(current, [...v2Envelopes.slice(0, -1), v2Envelopes[1]]), 'INVALID_ARCHIVE');
  reject(frameFrom(current, [...v2Envelopes.slice(0, -1), futureEnvelope]), 'UPGRADE_REQUIRED');
  // A count-at-cap frame is rejected before append KDF/record work; native Rust
  // tests additionally exercise a fully authenticated 127 -> 128 transition.
  const capped = frameFrom(current, [envelopes[0], ...Array(128).fill(envelopes[1])], 2);
  const cappedBefore = capped.slice();
  expectCode(() => api.appendSyntheticRegistration(capped, 0, 0, new Float64Array()), 'LIMITS_EXCEEDED');
  check(Buffer.from(capped).equals(Buffer.from(cappedBefore)));
  archiveRejections++;

  // Real WASM connection edits preserve the entire immutable ciphertext prefix.
  let history = current;
  let previousEnvelopes = splitFrame(current);
  for (const connections of [[0], [2, 0, 1], []]) {
    const before = history.slice();
    const next = api.editSyntheticConnections(history, 2, new Float64Array(connections));
    const parsed = splitHistory(next);
    check(parsed.heads.length === 6);
    check(parsed.envelopes.length === previousEnvelopes.length + 1);
    previousEnvelopes.forEach((envelope, index) => {
      check(Buffer.from(envelope).equals(Buffer.from(parsed.envelopes[index])));
    });
    check(parsed.heads[2] === parsed.envelopes.length - 2);
    check(Buffer.from(history).equals(Buffer.from(before)));
    const catalog = api.openSyntheticArchive(next);
    try {
      check(catalog.length() === 6 && catalog.connectionCount(2) === connections.length);
      check(catalog.secretFieldCount(2) === 2);
      check(catalog.issuerAccountIdentifier(2) === 'demo-account');
      check(catalog.connectionCount(1) === 1 && catalog.connectionCount(3) === 0);
      connections.forEach((id, index) => {
        check(catalog.connectionLabel(2, index) === ['Example MCP', 'Example CLI', 'Example CI'][id]);
      });
    } finally { catalog.lock(); catalog.free(); }
    previousEnvelopes = parsed.envelopes;
    history = next;
    connectionEditsVerified++;
  }
  for (const invalid of [-1, 0.5, 6, 2 ** 32, NaN, Infinity, -Infinity]) {
    expectCode(() => api.editSyntheticConnections(history, invalid, new Float64Array()), 'INVALID_ARCHIVE');
    expectCode(() => api.editSyntheticConnections(history, 0, new Float64Array([invalid])), 'INVALID_ARCHIVE');
  }
  expectCode(() => api.editSyntheticConnections(history, 0, new Float64Array([0, 0])), 'INVALID_ARCHIVE');
  expectCode(() => api.editSyntheticConnections(history, 0, new Float64Array([0, 1, 2, 0])), 'LIMITS_EXCEEDED');
  const parsedHistory = splitHistory(history);
  reject(withU32(history, parsedHistory.headOffset + 8, 2), 'INVALID_ARCHIVE');
  reject(withU32(history, 16, 513), 'LIMITS_EXCEEDED');
  const corruptHistory = history.slice();
  // Choose the actual old record 2 frame via prior envelope lengths.
  const record2End = 20 + parsedHistory.envelopes.slice(0, 4).reduce((sum, env) => sum + 4 + env.length, 0);
  check(record2End <= history.length);
  corruptHistory[record2End - 1] ^= 1;
  reject(corruptHistory, 'AUTHENTICATION_FAILED');
  const appendedHistory = api.appendSyntheticRegistration(history, 1, 0, new Float64Array([0]));
  const parsedAppend = splitHistory(appendedHistory);
  check(parsedAppend.heads.length === 7);
  parsedHistory.envelopes.forEach((env, index) => {
    check(Buffer.from(env).equals(Buffer.from(parsedAppend.envelopes[index])));
  });
  const appendedCatalog = api.openSyntheticArchive(appendedHistory);
  try { check(appendedCatalog.length() === 7 && appendedCatalog.connectionCount(2) === 0); }
  finally { appendedCatalog.lock(); appendedCatalog.free(); }
}

try {
  await run();
  console.log(JSON.stringify({
    check: 'actual-wasm-runtime', mode: folder, passed: true,
    checks, catalogsVerified, archiveRejections, registrationsVerified, connectionEditsVerified,
    rotationChecklistsVerified, rotationCutoversVerified, rotationRejections,
  }));
} catch {
  // Do not print thrown values, assertion operands, rows, archive bytes or keys.
  console.log(JSON.stringify({
    check: 'actual-wasm-runtime', mode: folder, passed: false,
    code: 'WASM_RUNTIME_CHECK_FAILED', checks, catalogsVerified, archiveRejections, registrationsVerified, connectionEditsVerified,
    rotationChecklistsVerified, rotationCutoversVerified, rotationRejections,
  }));
  process.exitCode = 1;
}
