import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/* The type scale's own sizes (globals.css @theme --text-micro … --text-lead).
   tailwind-merge does not know them, so it read `text-micro` as a text COLOUR:
   cn('text-micro', 'text-primary') kept only text-primary and the badge,
   counter or pill fell back to the inherited size (2026-10-28). */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['micro', 'caption', 'body', 'lead'] }] } },
});

/** Merge Tailwind class lists, resolving conflicts (last wins). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
