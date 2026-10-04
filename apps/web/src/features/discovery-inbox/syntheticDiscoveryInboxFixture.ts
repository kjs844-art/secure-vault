import type { DiscoveryInboxItem, DiscoverySourceKind } from "./discoveryInboxModel";

function item(
  id: string,
  serviceName: string,
  accountHint: string,
  confidence: DiscoveryInboxItem["confidence"],
  sourceKind: DiscoverySourceKind,
  sourceLabel: string,
  observedOn: string,
  note: string,
): DiscoveryInboxItem {
  return Object.freeze({
    id,
    serviceName,
    accountHint,
    confidence,
    sourceKind,
    sourceLabel,
    observedOn,
    note,
  });
}

/** Closed demo rows only. Not mail, export, or provider discovery results. */
export const SYNTHETIC_DISCOVERY_INBOX_ITEMS: readonly DiscoveryInboxItem[] = Object.freeze([
  item(
    "demo-workshop-confirmed",
    "Example AI Workshop",
    "demo-workshop-owner",
    "confirmed",
    "manual",
    "사용자가 직접 기록",
    "2026-09-12",
    "합성 금고에 같은 계정 힌트가 이미 있습니다.",
  ),
  item(
    "demo-lab-inferred",
    "Example Cloud Lab",
    "demo-lab-owner",
    "inferred",
    "export_hint",
    "닫힌 내보내기 예시",
    "2026-09-18",
    "파일 이름은 보였지만 원문은 이 화면에 없습니다.",
  ),
  item(
    "demo-notes-review",
    "Example Notes Board",
    "기록 없음",
    "needs_review",
    "mail_hint",
    "닫힌 메일 제목 예시",
    "2026-09-20",
    "제목만 있는 합성 힌트입니다. 메일 본문은 보관하지 않습니다.",
  ),
  item(
    "demo-shop-false",
    "Example Shop Newsletter",
    "demo-shop-list",
    "needs_review",
    "password_manager_hint",
    "닫힌 비밀번호 관리자 예시",
    "2026-09-21",
    "뉴스레터 구독처럼 보일 수 있어 오탐 후보입니다.",
  ),
]);
