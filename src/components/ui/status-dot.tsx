import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const dotVariants = cva('relative inline-flex h-1.5 w-1.5 rounded-full', {
  variants: {
    variant: {
      success: 'bg-state-success',
      error: 'bg-state-error',
      warning: 'bg-state-warning',
      neutral: 'bg-state-neutral',
      accent: 'bg-accent-primary',
    },
  },
  defaultVariants: {
    variant: 'neutral',
  },
})

export interface StatusDotProps extends VariantProps<typeof dotVariants> {
  /** Adds the animated ping ring — reserve for a genuinely live state
   * (the agent is actively running), not decoration. Animations should
   * communicate state changes, not decoration (ui-context.md § Visual
   * Principles). */
  pulse?: boolean
  className?: string
}

export function StatusDot({ variant, pulse, className }: StatusDotProps) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 items-center justify-center', className)}>
      {pulse ? (
        <span className={cn(dotVariants({ variant }), 'absolute h-full w-full animate-ping opacity-75')} />
      ) : null}
      <span className={cn(dotVariants({ variant }), 'h-1.5 w-1.5')} />
    </span>
  )
}
