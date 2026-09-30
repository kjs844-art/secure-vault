import type { CSSProperties } from "react";

const box: CSSProperties = {
  border: "2px solid currentColor",
  padding: "1.25rem",
  borderRadius: "0.75rem",
};

export function ErrorState({
  title = "화면을 불러오지 못했습니다",
  detail = "합성 데모만 사용합니다. 실제 계정이나 메일에 연결하지 않았습니다.",
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" style={box}>
      <p>
        <strong>{title}</strong>
      </p>
      <p>{detail}</p>
      {onRetry ? (
        <p>
          <button type="button" onClick={onRetry}>
            다시 시도
          </button>
        </p>
      ) : null}
    </div>
  );
}
