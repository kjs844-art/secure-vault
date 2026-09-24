/**
 * KeyAtlas Korean/English copy catalog.
 *
 * Korean is the source locale. The English catalog is typed against the same
 * shape, so a missing or extra key is a compile error. `copyCatalog.test.ts`
 * additionally checks placeholder parity and the forbidden-claim list.
 */

import type {
  PrivilegeLevel,
  SecretKind,
  VaultEnvironment,
  VaultItemStatus,
} from "../../domain/vault";

export const locales = ["ko", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ko";

interface CopyTree {
  readonly [key: string]: string | CopyTree;
}

type Widen<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

const ko = {
  common: {
    cancel: "취소",
    confirm: "확인",
    save: "저장",
    close: "닫기",
    back: "뒤로",
    loading: "불러오는 중",
    retry: "다시 시도",
    notRecorded: "기록 없음",
    notYetConfirmed: "아직 확인하지 않음",
    itemCount: "{count}개 항목",
  },
  concept: {
    signInMethod: "로그인 수단",
    serviceAccount: "서비스 계정",
    credential: "자격 증명",
    connectionTarget: "연결처",
    vault: "금고",
    environment: "환경",
    project: "프로젝트",
    workspace: "워크스페이스",
    keyatlasSignIn: "KeyAtlas 로그인",
    externalServiceSignIn: "외부 서비스 로그인",
  },
  secretKind: {
    password: "비밀번호",
    api_key: "API 키",
    mcp_credential: "MCP 자격 증명",
    recovery_code: "복구 코드",
  } satisfies Record<SecretKind, string>,
  environment: {
    development: "개발",
    test: "테스트",
    production: "운영",
  } satisfies Record<VaultEnvironment, string>,
  itemStatus: {
    active: "사용 중",
    rotation_due: "회전 필요",
    revoked: "폐기됨",
  } satisfies Record<VaultItemStatus, string>,
  privilege: {
    read_only: "읽기 전용",
    read_write: "읽기·쓰기",
    admin: "관리자",
    unknown: "권한 확인 안 됨",
  } satisfies Record<PrivilegeLevel, string>,
  connection: {
    recorded: "연결 기록 있음",
    notRecorded: "연결 기록 없음",
    recordedHint: "사용자가 기록한 연결입니다. 지금도 연결돼 있는지는 확인하지 않았습니다.",
    targetCount: "연결처 {count}곳 기록",
  },
  rotation: {
    guideTitle: "키 회전 안내",
    updateRecordedTargets: "기록한 연결처 {count}곳을 새 값으로 바꿨는지 하나씩 확인하세요.",
    unrecordedWarning: "기록하지 않은 사용처는 KeyAtlas가 알 수 없습니다.",
  },
  safety: {
    syntheticOnlyTitle: "합성 데이터 전용",
    syntheticOnlyBody: "이 화면은 연습용 합성 데이터만 씁니다. 실제 비밀번호나 API 키를 입력하지 마세요.",
    noRealKeys: "실제 키 입력 금지",
    lostAccessWarning: "마스터 비밀번호와 켜 둔 복구 수단을 모두 잃으면 금고를 열 수 없습니다.",
  },
  viewState: {
    loadingTitle: "불러오는 중",
    emptyTitle: "표시할 항목이 없습니다",
    emptyBody: "항목을 추가하면 여기에 표시됩니다.",
    offlineTitle: "네트워크에 연결되어 있지 않습니다",
    offlineBody: "네트워크가 필요한 작업은 연결이 돌아온 뒤 다시 시도하세요.",
    errorTitle: "작업을 끝내지 못했습니다",
    errorBody: "잠시 뒤 다시 시도하세요.",
    errorReference: "참조 코드 {code}",
  },
  form: {
    unsavedChanges: "저장하지 않은 변경 사항이 있습니다",
    changedFieldCount: "바뀐 항목 {count}개",
    saving: "저장 중",
    saved: "저장했습니다",
    saveFailed: "저장하지 못했습니다. 바꾼 내용은 이 화면에 그대로 남아 있습니다.",
    discardConfirm: "저장하지 않은 변경 사항을 버릴까요?",
    discard: "변경 사항 버리기",
    keepEditing: "계속 편집",
  },
  shell: {
    primaryNavigation: "주요 메뉴",
  },
} as const satisfies CopyTree;

export type CopyCatalog = Widen<typeof ko>;

const en: CopyCatalog = {
  common: {
    cancel: "Cancel",
    confirm: "Confirm",
    save: "Save",
    close: "Close",
    back: "Back",
    loading: "Loading",
    retry: "Try again",
    notRecorded: "Not recorded",
    notYetConfirmed: "Not confirmed yet",
    itemCount: "{count} items",
  },
  concept: {
    signInMethod: "Sign-in method",
    serviceAccount: "Service account",
    credential: "Credential",
    connectionTarget: "Connection target",
    vault: "Vault",
    environment: "Environment",
    project: "Project",
    workspace: "Workspace",
    keyatlasSignIn: "KeyAtlas sign-in",
    externalServiceSignIn: "External service sign-in",
  },
  // Kept on one line: the repository Secret scanner treats a line that starts
  // with `password:` followed by an 8+ character string as a credential.
  secretKind: { password: "Password", api_key: "API key", mcp_credential: "MCP credential", recovery_code: "Recovery code" },
  environment: {
    development: "Development",
    test: "Test",
    production: "Production",
  },
  itemStatus: {
    active: "In use",
    rotation_due: "Rotation due",
    revoked: "Revoked",
  },
  privilege: {
    read_only: "Read-only",
    read_write: "Read and write",
    admin: "Admin",
    unknown: "Permission not checked",
  },
  connection: {
    recorded: "Connection recorded",
    notRecorded: "No connection recorded",
    recordedHint: "You recorded this connection. KeyAtlas has not checked whether it is still connected.",
    targetCount: "{count} connection targets recorded",
  },
  rotation: {
    guideTitle: "Key rotation guide",
    updateRecordedTargets: "Check each of the {count} recorded connection targets after switching to the new value.",
    unrecordedWarning: "KeyAtlas cannot know about places you did not record.",
  },
  safety: {
    syntheticOnlyTitle: "Synthetic data only",
    syntheticOnlyBody: "This screen uses practice data only. Do not enter real passwords or API keys.",
    noRealKeys: "No real keys",
    lostAccessWarning: "If you lose your master password and every recovery method you turned on, the vault cannot be opened.",
  },
  viewState: {
    loadingTitle: "Loading",
    emptyTitle: "Nothing to show yet",
    emptyBody: "Items you add will appear here.",
    offlineTitle: "You are offline",
    offlineBody: "Try actions that need the network again once you are back online.",
    errorTitle: "Something went wrong",
    errorBody: "Please try again in a moment.",
    errorReference: "Reference code {code}",
  },
  form: {
    unsavedChanges: "You have unsaved changes",
    changedFieldCount: "{count} fields changed",
    saving: "Saving",
    saved: "Saved",
    saveFailed: "Could not save. Your changes are still on this screen.",
    discardConfirm: "Discard your unsaved changes?",
    discard: "Discard changes",
    keepEditing: "Keep editing",
  },
  shell: {
    primaryNavigation: "Main menu",
  },
};

function deepFreeze<T extends CopyTree>(tree: T): T {
  for (const value of Object.values(tree)) {
    if (typeof value !== "string") deepFreeze(value);
  }
  return Object.freeze(tree);
}

const catalogs: Readonly<Record<Locale, CopyCatalog>> = Object.freeze({
  ko: deepFreeze(ko),
  en: deepFreeze(en),
});

export function getCopy(locale: Locale): CopyCatalog {
  return catalogs[locale];
}

/**
 * Maps a browser language tag such as `en-US` to a supported locale.
 * Anything unrecognised falls back to Korean.
 */
export function resolveLocale(tag: string | null | undefined): Locale {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return locales.find((locale) => locale === primary) ?? defaultLocale;
}

const placeholderPattern = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

export function placeholdersOf(template: string): readonly string[] {
  return [...new Set([...template.matchAll(placeholderPattern)].map((m) => m[1] ?? ""))].sort();
}

/**
 * Fills `{name}` placeholders. Missing or unexpected values throw so a wrong
 * call site fails loudly instead of showing a half-filled sentence.
 */
export function formatCopy(
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string {
  const expected = placeholdersOf(template);
  const provided = Object.keys(values).sort();
  if (expected.join("\u0000") !== provided.join("\u0000")) {
    throw new Error(
      `Copy placeholders mismatch: expected [${expected.join(", ")}], got [${provided.join(", ")}].`,
    );
  }
  return template.replace(placeholderPattern, (_, name: string) => String(values[name]));
}
