import { useEffect, useId, useRef, useState } from "react";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { SyntheticVaultSession } from "./SyntheticVaultSession";
import { LocalCatalogSearch } from "./LocalCatalogSearch";
import {
  SYNTHETIC_CONNECTION_OPTIONS, sameSyntheticConnectionOrder, seedSyntheticConnectionEdit,
  type SyntheticConnectionId,
} from "./syntheticConnectionEditorModel";

type EditSession = Pick<SyntheticVaultSession, "editConnections">;

/** Parent keys this subtree by the same generation that produced entries. */
export function SyntheticEditableCatalog({ entries, generation, session }: {
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly generation: number;
  readonly session: EditSession;
}) {
  const [editingReference, setEditingReference] = useState<number | null>(null);
  return <LocalCatalogSearch entries={entries} renderEntryActions={(entry) => (
    <SyntheticConnectionEditor key={`${generation}-${entry.reference}`} entry={entry}
      generation={generation} session={session} active={editingReference === entry.reference}
      onOpen={() => setEditingReference(entry.reference)} onClose={() => setEditingReference(null)} />
  )} />;
}

export function SyntheticConnectionEditor({ entry, generation, session, active, onOpen, onClose }: {
  readonly entry: LocalCatalogEntryV1;
  readonly generation: number;
  readonly session: EditSession;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocusOnClose = useRef(false);
  useEffect(() => {
    // Changing the selected row must not steal focus from the newly opened form.
    if (!active && restoreFocusOnClose.current) {
      restoreFocusOnClose.current = false;
      button.current?.focus();
    }
  }, [active]);
  // Conservative local-display hint only. Rust checks all hidden semantics on save.
  const initial = seedSyntheticConnectionEdit(entry);
  if (initial === null) return <p data-testid={`connection-edit-unavailable-${entry.reference}`}>
    이 항목은 현재 합성 연결 편집 화면에서 지원하지 않습니다. 기존 기록은 변경하지 않습니다.
  </p>;
  if (!active) return <div className="vault-actions connection-editor-actions">
    <button ref={button} type="button" data-testid={`connection-edit-open-${entry.reference}`} onClick={onOpen}>
      예시 {entry.reference + 1} 연결 기록 편집
    </button>
  </div>;
  return <ConnectionEditorForm key={`${generation}-${entry.reference}`} entry={entry}
    generation={generation} session={session} initial={initial} onClose={() => {
      restoreFocusOnClose.current = true;
      onClose();
    }} />;
}

function ConnectionEditorForm({ entry, generation, session, initial, onClose }: {
  readonly entry: LocalCatalogEntryV1;
  readonly generation: number;
  readonly session: EditSession;
  readonly initial: readonly SyntheticConnectionId[];
  readonly onClose: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const submitted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<readonly SyntheticConnectionId[]>(() => [...initial]);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { heading.current?.focus(); }, []);
  const changed = !sameSyntheticConnectionOrder(initial, selected);
  const removed = initial.filter((connection) => !selected.includes(connection));
  const names = (ids: readonly SyntheticConnectionId[]) => ids.length === 0
    ? "연결 기록 없음" : ids.map((value) => SYNTHETIC_CONNECTION_OPTIONS[value].label).join(" → ");

  function toggle(connection: SyntheticConnectionId, checked: boolean) {
    if (submitted.current) return;
    setSelected((previous) => checked
      ? previous.includes(connection) ? previous : [...previous, connection]
      : previous.filter((value) => value !== connection));
    setAcknowledged(false);
  }

  return <form className="synthetic-connection-editor" data-testid="connection-editor"
    aria-labelledby={`${id}-heading`} onSubmit={(event) => {
      event.preventDefault();
      if (!changed || !acknowledged || submitted.current) return;
      submitted.current = true;
      setSubmitting(true);
      // These values belong to this rendered editor, never a filtered array index
      // or session.viewGeneration read later inside an old event callback.
      void session.editConnections(generation, { reference: entry.reference, connectionIds: [...selected] });
      // Promise resolution is not success: only the session's authenticated
      // saved catalog may confirm the operation and replace this subtree.
    }}>
    <h4 ref={heading} tabIndex={-1} id={`${id}-heading`}>예시 {entry.reference + 1}의 연결 기록 수정</h4>
    <p>{entry.providerName} · {entry.itemName}</p>
    <p>발급 계정: {entry.issuerAccountIdentifier === null ? "기록 없음" : entry.issuerAccountIdentifier === "" ? "빈 값으로 기록됨" : entry.issuerAccountIdentifier}</p>
    <p data-testid="connection-edit-original">현재 기록 순서: {names(initial)}</p>
    <fieldset disabled={submitting}>
      <legend>저장할 연결 목록 — 체크 해제 후 다시 선택하면 순서가 바뀝니다</legend>
      {SYNTHETIC_CONNECTION_OPTIONS.map((option) => <label key={option.id}>
        <input type="checkbox" checked={selected.includes(option.id)}
          data-testid={`connection-edit-choice-${option.id}`}
          onChange={(event) => toggle(option.id, event.currentTarget.checked)} />
        {option.label} · {option.description}
      </label>)}
    </fieldset>
    <p data-testid="connection-edit-preview">변경 후 순서: {names(selected)}</p>
    {removed.length > 0 && <p className="connection-removal-warning" data-testid="connection-edit-removal">
      현재 목록에서 연결 기록 {removed.length}개를 제외합니다. 과거 암호화 이력은 보존하며 키 원문을 삭제하거나 외부 서비스 연결을 해제하지 않습니다.
    </p>}
    {selected.length === 0 && <p>0개를 선택하면 이 항목의 연결 기록만 비웁니다. API 키와 계정 정보는 그대로 보관합니다.</p>}
    <p>가상 연결 기록만 수정합니다. 실제 MCP/CLI 실행이나 외부 연결 확인은 하지 않습니다. 저장할 때 원본 전체를 다시 확인하며 지원하지 않는 항목은 변경하지 않습니다.</p>
    <label className="connection-editor-acknowledgement">
      <input type="checkbox" checked={acknowledged} disabled={submitting}
        data-testid="connection-edit-acknowledgement" onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
      {removed.length > 0 ? "연결 기록 제외를 포함해 위 변경 내용을 확인했습니다." : "위 합성 연결 기록 변경 내용을 확인했습니다."}
    </label>
    <div className="vault-actions">
      <button type="submit" disabled={!changed || !acknowledged || submitting} data-testid="connection-edit-submit">
        {submitting ? "저장 확인 중" : "연결 기록 변경 저장"}
      </button>
      <button type="button" disabled={submitting} onClick={onClose} data-testid="connection-edit-cancel">취소 · 기록 유지</button>
    </div>
    {!changed && <small>아직 변경한 내용이 없습니다. 같은 선택과 순서는 다시 저장하지 않습니다.</small>}
    <small>과거 기록을 포함한 암호문은 512 KiB, 이력은 최대 512개까지입니다. 한도/충돌로 저장하지 못하면 자동 재시도하지 않습니다.</small>
  </form>;
}
