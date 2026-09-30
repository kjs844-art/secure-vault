import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";
import { SyntheticToolPanel } from "./SyntheticToolPanel";

function renderPanel(): string {
  const session = {
    state: { phase: "locked", entries: [], errorCode: null },
    viewGeneration: 0,
    subscribe: () => () => {},
    lock: () => {},
  } as unknown as SyntheticVaultSession;
  return renderToStaticMarkup(createElement(SyntheticToolPanel, { session }));
}

describe("synthetic local tool search input", () => {
  it("explains the UTF-8 byte limit and describes the input accessibly", () => {
    const html = renderPanel();
    expect(html).toContain('aria-invalid="false"');
    expect(html).toContain('aria-describedby="local-tool-privacy local-tool-query-count"');
    expect(html).toContain("검색어 0/128 UTF-8 bytes");
    expect(html).toContain("검색어는 UTF-8 기준 최대 128바이트");
    expect(html).toContain("외부 AI 연결 없음");
    expect(html).not.toContain("disabled=\"\"");
  });
});
