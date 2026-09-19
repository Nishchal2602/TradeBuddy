import type { ReactNode } from 'react'
import { CardHeader, CardTitle } from './card'
import { Badge } from './badge'

export interface SectionHeaderProps {
  icon?: ReactNode
  title: string
  /** Rendered as a small count badge immediately after the title, e.g. the
   * open-position count on "CURRENT POSITIONS". */
  count?: number
  /** Arbitrary right-aligned content — a status badge, a link, a live
   * indicator. */
  right?: ReactNode
}

/** The card-header pattern repeated across every section in the reference
 * designs: icon + title + optional count on the left, a status/action on
 * the right. Built on Card's own CardHeader/CardTitle rather than
 * duplicating their layout. */
export function SectionHeader({ icon, title, count, right }: SectionHeaderProps) {
  return (
    <CardHeader>
      <CardTitle>
        {icon}
        {title}
        {count !== undefined ? <Badge variant="count">{count}</Badge> : null}
      </CardTitle>
      {right}
    </CardHeader>
  )
}
