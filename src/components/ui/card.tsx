import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Three-tier surface hierarchy (reference designs' "tonal ladder," adapted
 * to this system's border-plus-contrast depth strategy instead of pure
 * tonal stacking): Card is the top-level section on a screen; Panel nests
 * inside a Card for a sub-grouping; Tile is the smallest unit, for a
 * single stat inside a grid. Never nest a Card inside a Card.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-2.5 rounded-xl border border-border-default bg-bg-surface p-2.5', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between gap-2', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('type-headline-sm flex items-center gap-1.5 text-text-primary', className)} {...props} />
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg bg-bg-elevated p-1.5', className)} {...props} />
}

export function Tile({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col rounded-md bg-bg-elevated p-1', className)} {...props} />
}
