import type { ReactNode } from 'react'

export interface Column<T> {
  header: string
  render: (row: T) => ReactNode
  align?: 'left' | 'right'
  className?: string
}

// Real columns, not the extension's "one card per asset" (ui-context.md:
// "the popup is too narrow for tabular columns to stay legible at this
// density" — a constraint that does not apply at desktop width).
export function DataTable<T>({ columns, rows, keyFor, onRowClick }: {
  columns: Column<T>[]
  rows: T[]
  keyFor: (row: T) => string
  onRowClick?: (row: T) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-w-bg-raised">
            {columns.map((col) => (
              <th
                key={col.header}
                className={`wt-label text-w-muted border-b border-w-border px-4 py-3 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={keyFor(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-w-border-soft last:border-b-0 ${onRowClick ? 'cursor-pointer transition-colors hover:bg-w-glass-strong' : ''}`}
            >
              {columns.map((col) => (
                <td key={col.header} className={`wt-body-sm px-4 py-3 ${col.align === 'right' ? 'text-right' : 'text-left'} ${col.className ?? ''}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
