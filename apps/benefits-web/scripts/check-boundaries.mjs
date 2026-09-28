import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(full));
    else result.push(full);
  }
  return result;
}

const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const allowedRuntime = new Set([
  "@tanstack/react-query", "@tanstack/react-router", "@tanstack/react-start", "react", "react-dom",
]);
assert.deepEqual(Object.keys(manifest.dependencies).sort(), [...allowedRuntime].sort(),
  "Runtime dependency additions require integration/security review");
for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
  assert.equal(manifest.scripts[hook], undefined, "No copied donor install hook");
}
for (const version of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, "Pin direct versions");
}
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
assert.equal(lock.lockfileVersion, 3);
for (const [name, record] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert.ok(record.resolved, "All downloaded packages need a registry source");
  const url = new URL(record.resolved);
  assert.equal(url.origin, "https://registry.npmjs.org", "Unexpected package registry");
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.match(record.integrity ?? "", /^sha512-/, "Package integrity is required");
}

const sourceFiles = (await filesIn(path.join(root, "src")))
  .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.endsWith("routeTree.gen.ts"));
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = ts.preProcessFile(text, true, true).importedFiles;
  for (const entry of imports) {
    const name = entry.fileName;
    if (name.startsWith(".")) {
      assert.ok(path.resolve(path.dirname(file), name).startsWith(path.join(root, "src") + path.sep),
        "Do not import another app/vault/checkout");
    } else {
      assert.ok([...allowedRuntime].some((pkg) => name === pkg || name.startsWith(pkg + "/")),
        "Unreviewed source dependency in " + relative);
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      assert.ok(!/^(?:fetch|eval|Function|require|console\.(?:log|error|warn))$/.test(callee),
        "Unreviewed network/dynamic/logging call in " + relative);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
          "Dynamic module expressions require review");
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const value = node.getText(source);
      if (value === "process.env") assert.equal(relative, "src/server.ts");
      assert.notEqual(value, "import.meta.env", "No ambient browser env exposure");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const client = (await filesIn(path.join(root, ".output/public")))
  .filter((file) => /\.(?:js|html|css)$/.test(file));
assert.ok(client.some((file) => file.endsWith(".js")), "Build before checking boundaries");
for (const file of client) {
  const content = await readFile(file, "utf8");
  for (const forbidden of [
    "KEYATLAS_BENEFITS_MODE", "MODE_NOT_AVAILABLE", "INTEGRATION_NOT_CONNECTED",
    "MAIL_INPUT_INVALID", "MAIL_LIMIT_EXCEEDED", "CANDIDATE_INPUT_INVALID",
    "CANDIDATE_EVIDENCE_INVALID", "keyatlas.gmail-candidates.v1",
    "keyatlas.gmail-review.v1", "keyatlas.mail-analysis-receipt.v1", "QUOTA_UNAVAILABLE",
    "keyatlas.benefit-review.v1", "REVIEW_STORE_UNAVAILABLE", "REVIEW_OPERATION_CONFLICT",
    "keyatlas.candidate-inbox.v1", "keyatlas.candidate-staging.v1", "getVerifiedAnalysisHandoff",
    "SUPABASE_SERVICE_ROLE_KEY", "APP_USER_CONNECTION_KEY_SECRET",
    "APP_USER_CONNECTIONS_ENCRYPTION_KEY", "api.lovable.dev",
    "ai.gateway.lovable.dev", "connector-gateway.lovable.dev",
    "cdn.jsdelivr.net", "document.modelContext",
  ]) {
    assert.ok(!content.includes(forbidden), "Unexpected server/provider marker in client output");
  }
}
console.log(JSON.stringify({
  check: "benefits-static-build-boundaries", result: "passed",
  sourceFiles: sourceFiles.length, clientFiles: client.length,
  limits: "Targeted source/lock/bundle checks; not a security audit or network sandbox",
}));
