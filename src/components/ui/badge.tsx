import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Compact status/action label — the badge vocabulary the decision feed and
 * positions view are built around (ui-context.md § Decision Card Language).
 * A generic, domain-agnostic primitive: `long`/`short`/`hold`/`flat` are
 * named for readability at call sites that render trading state directly,
 * but they resolve to the same underlying semantic colors as
 * `success`/`error`/`neutral` — feature code decides which name reads
 * better in context, both are always available.
 *
 * Deliberately not "not the only way to communicate meaning" on its own
 * (ui-context.md § Icons) — pair with an icon or explicit text, never rely
 * on color alone for something the user must act on.
 */
const badgeVariants = cva(
  'type-label-xs inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5',
  {
    variants: {
      variant: {
        long: 'bg-state-success-subtle text-state-success',
        short: 'bg-state-error-subtle text-state-error',
        hold: 'bg-state-neutral-subtle text-state-neutral',
        flat: 'bg-bg-elevated text-text-secondary',
        accent: 'bg-accent-subtle text-accent-primary',
        success: 'bg-state-success-subtle text-state-success',
        error: 'bg-state-error-subtle text-state-error',
        warning: 'bg-state-warning-subtle text-state-warning',
        neutral: 'bg-state-neutral-subtle text-state-neutral',
        count: 'bg-bg-elevated text-text-secondary font-semibold',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
