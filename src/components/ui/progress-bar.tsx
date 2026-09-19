import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const fillVariants = cva('h-full rounded-full transition-all duration-300', {
  variants: {
    variant: {
      accent: 'bg-accent-primary',
      success: 'bg-state-success',
      error: 'bg-state-error',
      warning: 'bg-state-warning',
    },
  },
  defaultVariants: {
    variant: 'accent',
  },
})

export interface ProgressBarProps extends VariantProps<typeof fillVariants> {
  /** 0-100. Not clamped here — callers pass an already-valid percentage
   * (e.g. confidence, cycle progress); clamping silently would hide a
   * caller bug rather than surface it. */
  value: number
  className?: string
}

/**
 * A plain linear meter — deliberately generic. The confidence-threshold
 * meter (with its pass/fail marker) and the SL/entry/TP price-ladder
 * gauge are richer, domain-specific compositions deferred to the Decision
 * and Positions steps, once their real data shapes exist; this is the
 * shared primitive they'll build on, not a stand-in for either.
 */
export function ProgressBar({ value, variant, className }: ProgressBarProps) {
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated', className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={fillVariants({ variant })} style={{ width: `${value}%` }} />
    </div>
  )
}
