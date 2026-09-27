import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("AI metadata preview disclosure", () => {
  it("makes clear that the allowlisted synthetic data stays in this preview", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("현재 실제 AI 서비스에 연결하거나 데이터를 전송하지 않습니다");
    expect(html).toContain("합성 데모 데이터 중 허용목록에 포함된 항목만 화면에 미리 보여줍니다");
    expect(html).toContain("서비스명·환경·권한·날짜도 민감할 수 있습니다");
    expect(html).toContain("외부에 복사하거나 공유하기 전에 내용을 직접 확인하세요");
    expect(html).toContain("허용목록 미리보기 보기");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("AI 전송 데이터 미리보기");
    expect(html).not.toContain("전달합니다.");
  });
});
