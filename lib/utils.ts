import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and resolve Tailwind class conflicts.
 * Standard shadcn/ui helper — kept at the project-root `lib/` boundary
 * (code-standards.md § File Organization) rather than `src/lib/`, reachable
 * via the `@/lib/*` alias so shadcn-generated components resolve unmodified.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
