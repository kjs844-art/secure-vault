import type { ReactNode } from "react";

export interface KeyValueEntry {
  readonly id: string;
  readonly term: ReactNode;
  readonly value: ReactNode;
}

export interface KeyValueListProps {
  readonly entries: readonly KeyValueEntry[];
}

/**
 * Semantic term/value pairs. Values must already be display-safe labels;
 * this component never receives secret material.
 */
export function KeyValueList({ entries }: KeyValueListProps) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error("Key/value entry ids must be unique.");
    }
    ids.add(entry.id);
  }
  if (entries.length === 0) return null;
  return (
    <dl className="ka-kv">
      {entries.map((entry) => (
        <div className="ka-kv__row" key={entry.id}>
          <dt className="ka-kv__term">{entry.term}</dt>
          <dd className="ka-kv__value">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
