import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalVaultBridgeFailureGuidance } from "./LocalVaultPanel";

/** Static guidance rendering only, not Worker/network/browser recovery evidence. */
describe("local vault runtime failure guidance", () => {
  it("explains uncertain runtime failure and user-controlled recovery without destructive advice", () => {
    const html = renderToStaticMarkup(createElement(LocalVaultBridgeFailureGuidance, {
      state: { phase: "error", errorCode: "BRIDGE_FAILURE" },
    }));
    expect(html).toContain('data-testid="vault-bridge-error"');
    expect(html).toContain("원인은 아직 확인되지 않았습니다");
    expect(html).toContain("실행 파일 로딩이나 백그라운드 작업(Worker) 시작·통신");
    expect(html).toContain("생겼을 수 있습니다");
    expect(html).toContain("인터넷 연결 상태");
    expect(html).toContain("로컬로 실행 중이라면 미리보기 서버가 켜져 있는지");
    expect(html).toContain("연결이나 실행 환경을 복구한 뒤");
    expect(html).toContain("‘저장된 합성 금고 열기’를 직접 눌러");
    expect(html).toContain("브라우저 데이터를 삭제하거나 금고를 초기화하지 마세요");
    expect(html).toContain("자동 초기화·자동 재시도는 하지 않습니다");
    expect(html).not.toMatch(/<(button|a|script|iframe|input)\b/);
    expect(html).not.toContain("오프라인 지원");
    expect(html).not.toContain("네트워크 오류입니다");
  });

  it.each(["locked", "busy", "empty", "open"] as const)(
    "shows no failure guidance in the %s state even with a stale error code", (phase) => {
      expect(renderToStaticMarkup(createElement(LocalVaultBridgeFailureGuidance, {
        state: { phase, errorCode: "BRIDGE_FAILURE" },
      }))).toBe("");
    },
  );

  it.each([null, "AUTHENTICATION_FAILED", "LIMITS_EXCEEDED", "STORAGE_FAILED", "PRIVATE_DETAIL"])(
    "does not misclassify other errors or publish untrusted details: %s", (errorCode) => {
      expect(renderToStaticMarkup(createElement(LocalVaultBridgeFailureGuidance, {
        state: { phase: "error", errorCode },
      }))).toBe("");
    },
  );
});
