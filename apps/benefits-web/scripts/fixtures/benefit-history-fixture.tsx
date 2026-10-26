/** Synthetic-only browser host; actual product components, no provider or persistence. */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DemoExperience } from "../../src/components/mvp-demo/DemoExperience.tsx";
import { ServiceList } from "../../src/components/mvp-demo/ServiceList.tsx";
import { AttentionList } from "../../src/components/mvp-demo/AttentionList.tsx";
import { buildDemoData, collectAttention, type DemoDataset } from "../../src/lib/mvp-demo-data.ts";
import { selectDemoHistoryView } from "../../src/lib/demo-benefit-history.ts";
import "../../src/styles.css";

const REFERENCE = Date.parse("2026-02-28T00:00:00.000Z");
const DAY = 86400000;
const MODES = ["normal", "expired-benefit", "ended-trial", "date-only", "impossible-service", "escaped"] as const;
type Mode = typeof MODES[number];
function sample(mode: Exclude<Mode, "normal">): DemoDataset {
  const base = buildDemoData(REFERENCE), future = new Date(REFERENCE + DAY).toISOString();
  const past = new Date(REFERENCE - DAY).toISOString();
  const service = { ...base.services[1]!, id: "synthetic-history-service",
    trial_ends_at: mode === "ended-trial" ? past : mode === "impossible-service" ? "2026-02-30T00:00:00.000Z" : future };
  const benefit = { ...base.benefits[0]!, id: "synthetic-history-benefit", service_id: service.id,
    name: mode === "escaped" ? "<img src=x onerror=alert(1)>" : "합성 체험 기록",
    benefit_kind: "trial" as const, granted_amount: 14, remaining_amount: 5,
    expires_at: mode === "expired-benefit" ? past : mode === "date-only" ? "2026-02-27"
      : mode === "impossible-service" ? null : future, extra_limit_note: null };
  return { ...base, services: [service], benefits: [benefit] };
}
function Scenario({ mode }: { mode: Exclude<Mode, "normal"> }) {
  const dataset = useMemo(() => selectDemoHistoryView(sample(mode), "review", REFERENCE), [mode]);
  const [selected, setSelected] = useState<string | null>(null);
  function focusService(id: string) {
    if (!dataset.services.some((service) => service.id === id)) return;
    setSelected(id);
    document.getElementById(`demo-svc-${id}`)?.focus();
  }
  return <section aria-label="합성 경계 조건">
    <h1>합성 날짜 경계 검사</h1>
    <p>합성 기록이며 실제 계정·메일·잔액을 조회하지 않습니다.</p>
    <section aria-label="합성 확인 항목">
      <AttentionList items={collectAttention(dataset, new Date(REFERENCE))} onFocusService={focusService} />
    </section>
    <ServiceList dataset={dataset} selectedId={selected} onSelect={setSelected} referenceTime={REFERENCE} />
  </section>;
}
export function BenefitHistoryFixture() {
  const [mode, setMode] = useState<Mode>("normal");
  return <main data-testid="history-fixture" data-mode={mode}>
    <nav aria-label="합성 회귀 조건">
      {MODES.map((value) => <button key={value} type="button" data-testid={`mode-${value}`}
        aria-pressed={mode === value} onClick={() => setMode(value)}>합성 보기 {value}</button>)}
    </nav>
    {mode === "normal" ? <DemoExperience referenceTime={REFERENCE} /> : <Scenario key={mode} mode={mode} />}
  </main>;
}
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (!root) throw new Error("HISTORY_FIXTURE_ROOT_MISSING");
  createRoot(root).render(<BenefitHistoryFixture />);
}
