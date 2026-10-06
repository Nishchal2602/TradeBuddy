import type { ReactNode } from 'react'

// Web dashboard's own badge, independent of @/components/ui/badge (the
// extension's version hardcodes its token names — bg-state-success-subtle
// etc — which don't exist in this app's stylesheet). Variants map onto
// this palette's much smaller semantic set: pos/neg/accent/neutral/muted.
export type BadgeVariant = 'pos' | 'neg' | 'accent' | 'neutral' | 'muted'

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  pos: 'text-w-pos border-w-pos/30 bg-w-pos/10',
  neg: 'text-w-neg border-w-neg/30 bg-w-neg/10',
  accent: 'text-w-accent border-w-accent/30 bg-w-accent-dim',
  neutral: 'text-w-text border-w-border bg-w-glass-strong',
  muted: 'text-w-muted border-w-border-soft bg-transparent',
}

export function Badge({ children, variant = 'neutral' }: { children: ReactNode; variant?: BadgeVariant }) {
  return (
    <span className={`wt-label inline-flex items-center rounded-full border px-2.5 py-1 ${VARIANT_CLASSES[variant]}`}>
      {children}
    </span>
  )
}
