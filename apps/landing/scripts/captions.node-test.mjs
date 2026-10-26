import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { transformWithOxc } = require("vite");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
// Replace only these module boundaries; fail if App's imports/signature change.
// The component body and JSX under test are read directly from the source file.
const reactImport = 'import { useEffect, useRef, useState } from "react";';
const sceneImport = 'import Scene from "./landing/Scene";';
const appExport = "export default function App()";
for (const boundary of [reactImport, sceneImport, appExport]) assert.equal(source.split(boundary).length, 2);
const isolated = source
  .replace(reactImport, "const { useEffect, useRef, useState } = React;")
  .replace(sceneImport, "const Scene = () => null;")
  .replace(appExport, "module.exports.default = function App()");
const { code: compiled } = await transformWithOxc(isolated, "App.tsx", {
  jsx: { runtime: "classic" }, target: "es2022", tsconfig: false,
});

// Render the actual App with a supplied caption beat, without WebGL, a DOM,
// clocks, or a browser. This covers semantic markup, not speech or animation.
function renderCaption(beat) {
  let stateCalls = 0;
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports,
    React: {
      ...React,
      useEffect() {},
      useRef(initial) { return { current: initial }; },
      useState(initial) {
        stateCalls += 1;
        assert.ok(stateCalls <= 2, "Update the caption harness if App adds state");
        return [stateCalls === 2 ? beat : initial, () => {}];
      },
    },
  });
  const html = renderToStaticMarkup(module.exports.default());
  assert.equal(stateCalls, 2);
  const region = html.match(/<div class="captions"([^>]*)>([\s\S]*?)<\/div>/);
  assert.ok(region, "Stable caption live region remains mounted");
  return { attributes: region[1], content: region[2] };
}

const tags = ["01 · KEY", "02 · TURN", "03 · GATHER", "04 · LOCK"];
test("the live region announces a complete caption politely", () => {
  const { attributes } = renderCaption(1);
  assert.match(attributes, /role="status"/);
  assert.match(attributes, /aria-live="polite"/);
  assert.match(attributes, /aria-atomic="true"/);
});
test("the initial and between-scene live region contains no caption", () => {
  assert.equal(renderCaption(0).content, "");
});
for (let beat = 1; beat <= 4; beat += 1) {
  test(`beat ${beat} exposes only its active caption to semantic readers`, () => {
    const html = renderCaption(beat).content;
    assert.equal((html.match(/<p\b/g) ?? []).length, 1);
    assert.match(html, /class="caption on"/);
    assert.ok(html.includes(tags[beat - 1]));
    for (const tag of tags.filter((_, index) => index !== beat - 1)) assert.ok(!html.includes(tag));
  });
}
test("leaving the final scene leaves no stale caption in the live region", () => {
  assert.ok(renderCaption(4).content.includes(tags[3]));
  assert.equal(renderCaption(0).content, "");
});
