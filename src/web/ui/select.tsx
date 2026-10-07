// Lifted verbatim from decisions.tsx's own local component (WEB-2,
// 2026-10-08) — a second real consumer (the Experiments section's
// baseline-variant picker) appeared, so this is generalized here instead
// of copy-pasted a second time, same "extract once a second caller
// exists" discipline as use-poll.ts itself.
export function Select<T extends string>({ value, options, onChange, labels }: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="wt-body-sm rounded-md border border-w-border bg-w-bg-raised px-3 py-1.5 text-w-text"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {labels?.[opt] ?? opt}
        </option>
      ))}
    </select>
  )
}
