import { describe, expect, it, vi } from "vitest";
import {
  MvpConnectionContractError,
  MVP_CONNECTION_PROVIDER_SLUGS_V1,
  hasDuplicateMvpConnectionUsageV1,
  mvpConnectionProviderLabelsV1,
  mvpConnectionUsageLabelsV1,
  mvpConnectionVerificationLabelsV1,
  parseMvpConnectionReferenceV1,
} from "./mvpConnectionReference";

const valid = () => ({
  providerSlug: "openai",
  usage: "mcp_server",
  recordReference: 0,
  verification: "verified",
  usageNote: "합성 표시 문구",
  confirmationAcknowledged: false,
});

const expectError = (input: unknown, code: string) => {
  let captured: unknown = null;
  try {
    parseMvpConnectionReferenceV1(input);
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(MvpConnectionContractError);
  expect((captured as MvpConnectionContractError).code).toBe(code);
  expect((captured as MvpConnectionContractError).message).toBe(code);
};

describe("M03 합성 연결 참조 계약", () => {
  it("유효한 참조를 동결된 복사본으로 정규화한다", () => {
    const input = valid();
    const result = parseMvpConnectionReferenceV1(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(MVP_CONNECTION_PROVIDER_SLUGS_V1)("공개 allowlist 슬러그 %s를 받아들인다", (slug) => {
    const result = parseMvpConnectionReferenceV1({ ...valid(), providerSlug: slug });
    expect(result.providerSlug).toBe(slug);
  });

  it.each([
    null,
    undefined,
    42,
    "문자열",
    [],
    Object.create(valid()),  ])("객체가 아닌 입력 %s는 고정 오류로 거절한다", (input) => {
    expect(() => parseMvpConnectionReferenceV1(input)).toThrow(MvpConnectionContractError);
  });

  it("추가 필드, 상속 필드, 심볼 키를 거절한다", () => {
    expectError({ ...valid(), secret: "PRIVATE_TEXT" }, "INVALID_SHAPE");
    expectError({ ...valid(), [Symbol("extra")]: 1 }, "INVALID_SHAPE");
    const inherited = Object.create(valid()) as Record<string, unknown>;
    inherited.providerSlug = "openai";
    expectError(inherited, "INVALID_SHAPE");
  });

  it("getter를 실행하지 않고 거절한다", () => {
    const getter = vi.fn(() => "openai");
    const input = Object.defineProperty(valid(), "providerSlug", { get: getter });
    expect(() => parseMvpConnectionReferenceV1(input)).toThrow(MvpConnectionContractError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("열거되지 않은 필드를 거절한다", () => {
    const hidden = Object.defineProperty(valid(), "usageNote", {
      value: "합성",
      enumerable: false,
    });
    expectError(hidden, "INVALID_SHAPE");
  });

  it("알 수 없는 provider 슬러그를 고정 오류로 거절한다", () => {
    expectError({ ...valid(), providerSlug: "unknown-provider" }, "UNKNOWN_PROVIDER");
    expectError({ ...valid(), providerSlug: "OpenAI" }, "UNKNOWN_PROVIDER");
    expectError({ ...valid(), providerSlug: "" }, "UNKNOWN_PROVIDER");
    expectError({ ...valid(), providerSlug: null }, "UNKNOWN_PROVIDER");
  });

  it("provider 슬러그에 이메일·토큰·비밀 원문이 오면 allowlist 밖으로 거절한다", () => {
    expectError({ ...valid(), providerSlug: "example-provider-slug" }, "UNKNOWN_PROVIDER");
    expectError({ ...valid(), providerSlug: "user@example.com" }, "UNKNOWN_PROVIDER");
  });

  it("열린 usage 집합 밖 값을 거절한다", () => {
    expectError({ ...valid(), usage: "browser" }, "UNKNOWN_USAGE_KIND");
    expectError({ ...valid(), usage: "" }, "UNKNOWN_USAGE_KIND");
    expectError({ ...valid(), usage: null }, "UNKNOWN_USAGE_KIND");
  });

  it("레코드 참조 범위 밖 값을 거절한다", () => {
    expectError({ ...valid(), recordReference: -1 }, "UNKNOWN_REFERENCE");
    expectError({ ...valid(), recordReference: 128 }, "UNKNOWN_REFERENCE");
    expectError({ ...valid(), recordReference: 0.5 }, "UNKNOWN_REFERENCE");
    expectError({ ...valid(), recordReference: Number.NaN }, "UNKNOWN_REFERENCE");
    expectError({ ...valid(), recordReference: Number.POSITIVE_INFINITY }, "UNKNOWN_REFERENCE");
    expectError({ ...valid(), recordReference: "0" }, "UNKNOWN_REFERENCE");
  });

  it("usageNote 초과분을 절단하지 않고 거절한다", () => {
    const oversized = "a".repeat(65);
    expectError({ ...valid(), usageNote: oversized }, "OVERSIZED_INPUT");
    const exact = "가".repeat(64);
    expect(parseMvpConnectionReferenceV1({ ...valid(), usageNote: exact }).usageNote).toBe(exact);
  });

  it("비문자열 usageNote를 거절한다", () => {
    expectError({ ...valid(), usageNote: null }, "INVALID_SHAPE");
    expectError({ ...valid(), usageNote: 42 }, "INVALID_SHAPE");
  });

  it("알 수 없는 verification 상태를 거절한다", () => {
    expectError({ ...valid(), verification: "definitely" }, "CONFIRMATION_REQUIRED");
    expectError({ ...valid(), verification: null }, "CONFIRMATION_REQUIRED");
  });

  it("candidate와 needs_confirmation은 명시적 확인 없이 거절한다", () => {
    expectError(
      { ...valid(), verification: "candidate" },
      "CONFIRMATION_REQUIRED",
    );
    expectError(
      { ...valid(), verification: "needs_confirmation" },
      "CONFIRMATION_REQUIRED",
    );
    const acknowledgedCandidate = parseMvpConnectionReferenceV1({
      ...valid(),
      verification: "candidate",
      confirmationAcknowledged: true,
    });
    expect(acknowledgedCandidate.confirmationAcknowledged).toBe(true);
  });

  it("verified에 확인 플래그를 주면 지원되지 않는 확인으로 거절한다", () => {
    expectError(
      { ...valid(), verification: "verified", confirmationAcknowledged: true },
      "UNSUPPORTED_CONFIRMATION",
    );
  });

  it("confirmationAcknowledged는 boolean만 받는다", () => {
    expectError({ ...valid(), confirmationAcknowledged: "true" }, "INVALID_SHAPE");
    expectError({ ...valid(), confirmationAcknowledged: 1 }, "INVALID_SHAPE");
    expectError({ ...valid(), confirmationAcknowledged: null }, "INVALID_SHAPE");
  });

  it("열거 검사를 우회하는 Proxy ownKeys 함정을 거절한다", () => {
    const hostile = new Proxy(valid(), {
      ownKeys() {
        throw new Error("PRIVATE_TEXT");
      },
    });
    expect(() => parseMvpConnectionReferenceV1(hostile)).toThrow(MvpConnectionContractError);
  });

  it("동일 provider·usage·record 조합의 중복을 탐지한다", () => {
    const first = parseMvpConnectionReferenceV1(valid());
    const second = parseMvpConnectionReferenceV1({ ...valid(), usageNote: "다른 표시 문구" });
    expect(hasDuplicateMvpConnectionUsageV1([first, second])).toBe(true);
    const distinct = parseMvpConnectionReferenceV1({ ...valid(), usage: "cli" });
    expect(hasDuplicateMvpConnectionUsageV1([first, distinct])).toBe(false);
    expect(hasDuplicateMvpConnectionUsageV1([])).toBe(false);
  });

  it("라벨 표는 열린 집합과 정확히 일치한다", () => {
    expect(Object.keys(mvpConnectionProviderLabelsV1).sort()).toEqual(
      [...MVP_CONNECTION_PROVIDER_SLUGS_V1].sort(),
    );
    for (const label of Object.values(mvpConnectionProviderLabelsV1)) {
      expect(label.length).toBeGreaterThan(0);
    }
    for (const label of Object.values(mvpConnectionUsageLabelsV1)) {
      expect(label.length).toBeGreaterThan(0);
    }
    for (const label of Object.values(mvpConnectionVerificationLabelsV1)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
