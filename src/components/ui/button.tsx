import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * ui-context.md § Controls: "Pause/resume and run-now should be obvious
 * but not visually dominant" — primary is reserved for the one dominant
 * action per screen (Run Now); everything else defaults to secondary or
 * ghost. `danger` is for state-changing, hard-to-reverse actions (Close
 * Position), never for anything routine.
 */
const buttonVariants = cva(
  'type-headline-sm inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent-primary text-text-primary hover:opacity-90',
        secondary: 'bg-bg-elevated text-text-primary hover:bg-border-default',
        danger: 'bg-state-error-subtle text-state-error hover:bg-state-error hover:text-text-primary',
        ghost: 'bg-transparent text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
        // 44px minimum touch target (ui-context.md doesn't state this
        // explicitly, but it's the standard mobile/extension-popup
        // minimum and matches the reference designs' own icon buttons).
        icon: 'h-11 w-11 shrink-0',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
