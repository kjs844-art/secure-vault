import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Offline manifest/lock graph regression, not an audit or runtime compatibility
// proof. Build and smoke checks still need to exercise the installed packages.
const EXPECTED = {
  "@tanstack/react-start": "1.169.3",
  "@tanstack/react-router": "1.170.45",
  "@tanstack/router-core": "1.171.38",
  "@tanstack/start-server-core": "1.169.44",
} as const;
type FrameworkPackage = keyof typeof EXPECTED;
type DependencyMap = Record<string, string>;
interface PackageRecord {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
}
interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, PackageRecord>;
}
const manifest: PackageRecord = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock: Lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const frameworkNames = Object.keys(EXPECTED) as FrameworkPackage[];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function packageName(location: string): string {
  return location.split("node_modules/").at(-1) ?? "";
}

function canonicalUrl(name: FrameworkPackage): string {
  return `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${EXPECTED[name]}.tgz`;
}

function assertNoFrameworkAliases(location: string, row: PackageRecord): void {
  for (const field of dependencyFields) {
    for (const [name, spec] of Object.entries(row[field] ?? {})) {
      if (frameworkNames.includes(name as FrameworkPackage)) {
        assert(!spec.startsWith("npm:"), `${location} ${field}: framework dependency must not be aliased`);
      }
      for (const target of frameworkNames) {
        assert(!spec.startsWith(`npm:${target}@`) && spec !== `npm:${target}`,
          `${location} ${field}: renamed framework dependency ${name} is not permitted`);
      }
    }
  }
}

function assertAllFrameworkCopies(candidate: Lockfile): void {
  const found = new Set<FrameworkPackage>();
  for (const [location, row] of Object.entries(candidate.packages)) {
    assertNoFrameworkAliases(location || "lock root", row);
    for (const name of frameworkNames) {
      // Inspect every lock location, including renamed aliases and nested copies.
      const hasIdentity = packageName(location) === name || row.name === name
        || row.resolved?.startsWith(`https://registry.npmjs.org/${name}/-/`);
      if (!hasIdentity) continue;
      found.add(name);
      assert.equal(packageName(location), name, `${location}: framework alias location`);
      assert(row.name === undefined || row.name === name, `${location}: substituted package name`);
      assert.equal(row.version, EXPECTED[name], `${location}: incompatible framework copy`);
      assert.equal(row.resolved, canonicalUrl(name), `${location}: noncanonical package identity`);
      assert.notEqual(row.link, true, `${location}: linked framework package`);
      // Require ordinary registry integrity metadata, without claiming that this
      // offline check fetches or verifies the actual tarball bytes.
      assert.match(row.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/,
        `${location}: missing SHA-512 integrity metadata`);
    }
  }
  assert.deepEqual([...found].sort(), [...frameworkNames].sort(), "all four framework packages must exist");
}

function resolveLockedDependency(candidate: Lockfile, importer: string, name: string): string {
  let owner = importer;
  for (;;) {
    const location = `${owner ? `${owner}/` : ""}node_modules/${name}`;
    if (Object.hasOwn(candidate.packages, location)) return location;
    if (owner === "") break;
    const boundary = owner.lastIndexOf("/node_modules/");
    owner = boundary < 0 ? "" : owner.slice(0, boundary);
  }
  assert.fail(`${importer || "lock root"}: unresolved ${name}`);
}

function assertFrameworkEdges(candidate: Lockfile): void {
  const consumed = new Set<FrameworkPackage>();
  for (const [importer, row] of Object.entries(candidate.packages)) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const name of frameworkNames) {
        const spec = row[field]?.[name];
        if (spec === undefined) continue;
        consumed.add(name);
        assert(spec === EXPECTED[name] || (field === "peerDependencies" && spec === `^${EXPECTED[name]}`),
          `${importer || "lock root"} ${field}: unexpected ${name} requirement`);
        const resolved = resolveLockedDependency(candidate, importer, name);
        const dependency = candidate.packages[resolved];
        assert.equal(dependency?.version, EXPECTED[name], `${importer}: resolves incompatible ${name}`);
        assert.equal(dependency?.resolved, canonicalUrl(name), `${importer}: resolves substituted ${name}`);
      }
    }
  }
  assert.deepEqual([...consumed].sort(), [...frameworkNames].sort(), "all required framework edges must be present");
}

test("framework manifest and lock retain the reviewed exact Start/Router pair", () => {
  assert.equal(lock.lockfileVersion, 3);
  for (const name of ["@tanstack/react-start", "@tanstack/react-router"] as const) {
    assert.equal(manifest.dependencies?.[name], EXPECTED[name], `${name}: direct manifest pin`);
    assert.equal(lock.packages[""]?.dependencies?.[name], EXPECTED[name], `${name}: lock root pin`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, EXPECTED[name], `${name}: installed root entry`);
  }
  assert.equal(lock.packages["node_modules/@tanstack/react-start"]?.dependencies?.["@tanstack/react-router"],
    EXPECTED["@tanstack/react-router"], "Start and the direct Router must require the same reviewed version");
  assertNoFrameworkAliases("manifest", manifest);
});

test("every nested framework copy has the reviewed version and canonical registry identity", () => {
  assertAllFrameworkCopies(lock);
});

test("all runtime, build-plugin and peer framework edges resolve the reviewed core pair", () => {
  assertFrameworkEdges(lock);
  for (const importer of [
    "@tanstack/react-router", "@tanstack/react-start-client", "@tanstack/react-start-rsc",
    "@tanstack/react-start-server", "@tanstack/router-generator", "@tanstack/start-client-core",
    "@tanstack/start-server-core", "@tanstack/start-storage-context", "@tanstack/start-plugin-core",
    "@tanstack/start-plugin-core/node_modules/@tanstack/router-plugin",
  ]) {
    const location = `node_modules/${importer}`;
    assert.equal(lock.packages[location]?.dependencies?.["@tanstack/router-core"], EXPECTED["@tanstack/router-core"],
      `${importer}: required router core edge must not disappear`);
  }
  for (const importer of ["@tanstack/react-start", "@tanstack/react-start-server", "@tanstack/start-plugin-core"]) {
    assert.equal(lock.packages[`node_modules/${importer}`]?.dependencies?.["@tanstack/start-server-core"],
      EXPECTED["@tanstack/start-server-core"], `${importer}: required server core edge must not disappear`);
  }
});

test("the graph guard detects a nested stale core even when the root remains correct", () => {
  for (const name of ["@tanstack/router-core", "@tanstack/start-server-core"] as const) {
    const mutated = structuredClone(lock);
    const importer = "node_modules/@tanstack/start-plugin-core";
    const nested = `${importer}/node_modules/${name}`;
    mutated.packages[nested] = { ...mutated.packages[`node_modules/${name}`], version: "0.0.0" };
    assert.equal(mutated.packages[`node_modules/${name}`]?.version, EXPECTED[name]);
    assert.equal(resolveLockedDependency(mutated, importer, name), nested);
    assert.throws(() => assertAllFrameworkCopies(mutated), /incompatible framework copy/);
    assert.throws(() => assertFrameworkEdges(mutated), /resolves incompatible/);
  }
});

test("unreferenced nested copies are inspected rather than hidden by root-only checks", () => {
  const mutated = structuredClone(lock);
  mutated.packages["node_modules/synthetic-unused/node_modules/@tanstack/react-router"] = {
    ...mutated.packages["node_modules/@tanstack/react-router"], version: "0.0.0",
  };
  assert.throws(() => assertAllFrameworkCopies(mutated), /incompatible framework copy/);
});

test("renamed framework aliases and substituted registry sources are rejected", () => {
  const aliased = structuredClone(lock);
  aliased.packages[""]!.dependencies = {
    ...aliased.packages[""]!.dependencies,
    "synthetic-alias": "npm:@tanstack/react-router@1.170.45",
  };
  assert.throws(() => assertAllFrameworkCopies(aliased), /renamed framework dependency/);
  const hiddenAlias = structuredClone(lock);
  hiddenAlias.packages["node_modules/synthetic-alias"] = {
    ...hiddenAlias.packages["node_modules/@tanstack/router-core"], name: "@tanstack/router-core",
  };
  assert.throws(() => assertAllFrameworkCopies(hiddenAlias), /framework alias location/);
  const substituted = structuredClone(lock);
  substituted.packages["node_modules/@tanstack/start-server-core"]!.resolved = "https://invalid.example/synthetic.tgz";
  assert.throws(() => assertAllFrameworkCopies(substituted), /noncanonical package identity/);
});

test("a transitive framework requirement cannot drift behind valid root versions", () => {
  const mutated = structuredClone(lock);
  mutated.packages["node_modules/@tanstack/react-start-client"]!.dependencies = {
    ...mutated.packages["node_modules/@tanstack/react-start-client"]!.dependencies,
    "@tanstack/react-router": "0.0.0",
  };
  assert.throws(() => assertFrameworkEdges(mutated), /unexpected @tanstack\/react-router requirement/);
});
