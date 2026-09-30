import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { WasmRotationChecklistAdapter } from "../../bridge/WasmRotationChecklistAdapter";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import init, {
  createSyntheticArchive,
  createSyntheticRotationCutover,
  editSyntheticConnections,
  inspectSyntheticRotationChecklist,
  openSyntheticArchive,
} from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import type { SyntheticRotationSelection } from "./syntheticRotation";
import {
  SyntheticVaultSession,
  type SyntheticRotationWorker,
} from "./SyntheticVaultSession";

const readySelection = Object.freeze({
  reference: 1,
  mcp: "user_confirmed",
  cli: "pending",
  ci: "pending",
  supersededRevocation: "user_confirmed",
} as const);

function argumentsFor(selection: SyntheticRotationSelection): [
  number, boolean, boolean, boolean, boolean, boolean, boolean, number,
] {
  const user = (value: SyntheticRotationSelection["mcp"]) => value === "user_confirmed";
  const provider = (value: SyntheticRotationSelection["mcp"]) => value === "provider_verified";
  return [
    selection.reference,
    user(selection.mcp), user(selection.cli), user(selection.ci),
    provider(selection.mcp), provider(selection.cli), provider(selection.ci),
    selection.supersededRevocation === "user_confirmed" ? 0 : 1,
  ];
}

/** Real WASM and fake IndexedDB; not browser Worker or real-browser storage evidence. */
function actualWorker(): SyntheticRotationWorker {
  return {
    async create() { return createSyntheticArchive(); },
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    async inspectRotation(bytes, selection) {
      const adapter = new WasmRotationChecklistAdapter(
        () => inspectSyntheticRotationChecklist(bytes, ...argumentsFor(selection)),
      );
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    async createRotationCutover(bytes, selection) {
      return createSyntheticRotationCutover(bytes, ...argumentsFor(selection));
    },
    cancel() { /* Inline harness cannot interrupt synchronous WASM. */ },
  };
}

async function inspectReady(session: SyntheticVaultSession) {
  const vaultGeneration = session.viewGeneration;
  await session.inspectRotation(vaultGeneration, readySelection);
  expect(session.rotationReviewState).toMatchObject({
    phase: "ready",
    checklist: {
      generation: "initial_0001",
      readinessState: "ready",
      remainingRequired: 0,
      remainingOptional: 0,
    },
  });
  return {
    vaultGeneration,
    reviewVersion: session.rotationReviewState.reviewVersion,
  };
}

describe("rotation actual-WASM/session/IndexedDB integration", { concurrent: false }, () => {
  beforeAll(async () => {
    const bytes = await readFile(new URL(
      "../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm",
      import.meta.url,
    ));
    await init({ module_or_path: new Uint8Array(bytes) });
  }, 30_000);

  it("commits, rereads, reauthenticates and restarts from the rotated archive", async () => {
    const database = new IDBFactory();
    const store = createSyntheticCiphertextStore(database);
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.create();
    const before = (await store.read())!;
    const token = await inspectReady(session);

    await session.commitRotationCutover(token.vaultGeneration, token.reviewVersion);
    expect(session.state.phase).toBe("open");
    expect(session.rotationReviewState.phase).toBe("idle");
    const saved = (await store.read())!;
    expect(saved).not.toEqual(before);
    expect(await actualWorker().open(saved)).toEqual(session.state.entries);

    session.lock();
    const restarted = new SyntheticVaultSession(createSyntheticCiphertextStore(database), actualWorker());
    await restarted.open();
    expect(restarted.state.phase).toBe("open");
    await restarted.inspectRotation(restarted.viewGeneration, readySelection);
    expect(restarted.rotationReviewState).toMatchObject({
      phase: "ready",
      checklist: { generation: "rotated_0002", readinessState: "ready" },
    });
    restarted.lock();
  }, 120_000);

  it("keeps one concurrent winner and durably preserves the authenticated loser", async () => {
    const database = new IDBFactory();
    const firstStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x31));
    const secondStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x32));
    const firstBaseWorker = actualWorker();
    const secondBaseWorker = actualWorker();
    let firstCandidate: Uint8Array | undefined;
    let secondCandidate: Uint8Array | undefined;
    const firstWorker: SyntheticRotationWorker = {
      ...firstBaseWorker,
      async createRotationCutover(bytes, selection) {
        const raw = await firstBaseWorker.createRotationCutover(bytes, selection);
        firstCandidate = raw.slice();
        return raw;
      },
    };
    const secondWorker: SyntheticRotationWorker = {
      ...secondBaseWorker,
      async createRotationCutover(bytes, selection) {
        const raw = await secondBaseWorker.createRotationCutover(bytes, selection);
        secondCandidate = raw.slice();
        return raw;
      },
    };
    const first = new SyntheticVaultSession(firstStore, firstWorker);
    await first.create();
    const second = new SyntheticVaultSession(secondStore, secondWorker);
    await second.open();
    const firstToken = await inspectReady(first);
    const secondToken = await inspectReady(second);

    await Promise.all([
      first.commitRotationCutover(firstToken.vaultGeneration, firstToken.reviewVersion),
      second.commitRotationCutover(secondToken.vaultGeneration, secondToken.reviewVersion),
    ]);
    expect([first.state.phase, second.state.phase].sort()).toEqual(["error", "open"]);
    expect([first.state.errorCode, second.state.errorCode])
      .toContain("STORAGE_CONFLICT_PRESERVED");

    const durable = createSyntheticCiphertextStore(database);
    const current = await durable.read();
    const conflicts = await durable.listConflictArchives();
    expect(current).not.toBeNull();
    expect(conflicts).toHaveLength(1);
    const firstWon = first.state.phase === "open";
    const winnerCandidate = firstWon ? firstCandidate : secondCandidate;
    const loserCandidate = firstWon ? secondCandidate : firstCandidate;
    expect(winnerCandidate).toBeDefined();
    expect(loserCandidate).toBeDefined();
    expect(current).toEqual(winnerCandidate!);
    expect(conflicts[0]!.bytes).toEqual(loserCandidate!);
    expect(conflicts[0]!.bytes).not.toEqual(current);
    const verifier = actualWorker();
    await expect(verifier.open(current!)).resolves.toHaveLength(3);
    await expect(verifier.open(conflicts[0]!.bytes)).resolves.toHaveLength(3);

    first.lock(); second.lock();
    const restarted = new SyntheticVaultSession(durable, actualWorker());
    await restarted.open();
    expect(restarted.state.phase).toBe("open");
    expect(await durable.listConflictArchives()).toEqual(conflicts);
    restarted.lock();
  }, 120_000);

  it("rejects tampering before write and preserves a candidate displaced after CAS", async () => {
    const tamperDatabase = new IDBFactory();
    const tamperStore = createSyntheticCiphertextStore(tamperDatabase);
    const baseWorker = actualWorker();
    const tamperingWorker: SyntheticRotationWorker = {
      ...baseWorker,
      async createRotationCutover(bytes, selection) {
        const corrupted = await baseWorker.createRotationCutover(bytes, selection);
        const last = corrupted.length - 1;
        corrupted[last] = corrupted[last]! ^ 1;
        return corrupted;
      },
    };
    const tampered = new SyntheticVaultSession(tamperStore, tamperingWorker);
    await tampered.create();
    const beforeTamper = (await tamperStore.read())!;
    const tamperToken = await inspectReady(tampered);
    await tampered.commitRotationCutover(tamperToken.vaultGeneration, tamperToken.reviewVersion);
    expect(tampered.state.errorCode).toBe("INVALID_ARCHIVE");
    expect(await tamperStore.read()).toEqual(beforeTamper);
    expect(await tamperStore.listConflictArchives()).toEqual([]);
    tampered.lock();

    const raceDatabase = new IDBFactory();
    const durable = createSyntheticCiphertextStore(raceDatabase, (target) => target.fill(0x41));
    const setup = new SyntheticVaultSession(durable, actualWorker());
    await setup.create();
    setup.lock();
    let workerCandidate: Uint8Array | undefined;
    let casCandidate: Uint8Array | undefined;
    let installedSuccessor: Uint8Array | undefined;
    const raceBaseWorker = actualWorker();
    const racingWorker: SyntheticRotationWorker = {
      ...raceBaseWorker,
      async createRotationCutover(bytes, selection) {
        const raw = await raceBaseWorker.createRotationCutover(bytes, selection);
        workerCandidate = raw.slice();
        return raw;
      },
    };
    const racingStore = {
      ...durable,
      async compareAndSwapArchivePreservingConflict(expected: Uint8Array, next: Uint8Array) {
        casCandidate = next.slice();
        const outcome = await durable.compareAndSwapArchivePreservingConflict(expected, next);
        if (outcome.kind === "updated") {
          const successor = editSyntheticConnections(next, 1, new Float64Array([2]));
          installedSuccessor = successor.slice();
          expect(await durable.compareAndSwapArchive(next, successor)).toBe("updated");
        }
        return outcome;
      },
    };
    const raced = new SyntheticVaultSession(racingStore, racingWorker);
    await raced.open();
    const raceToken = await inspectReady(raced);
    await raced.commitRotationCutover(raceToken.vaultGeneration, raceToken.reviewVersion);
    expect(raced.state).toEqual({
      phase: "error",
      entries: [],
      errorCode: "STORAGE_CONFLICT_PRESERVED",
    });
    const current = await durable.read();
    const conflicts = await durable.listConflictArchives();
    expect(current).not.toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(workerCandidate).toBeDefined();
    expect(casCandidate).toEqual(workerCandidate!);
    expect(installedSuccessor).toBeDefined();
    expect(current).toEqual(installedSuccessor!);
    expect(conflicts[0]!.bytes).toEqual(workerCandidate!);
    const verifier = actualWorker();
    await expect(verifier.open(current!)).resolves.toHaveLength(3);
    await expect(verifier.open(conflicts[0]!.bytes)).resolves.toHaveLength(3);
    raced.lock();
  }, 120_000);
});
