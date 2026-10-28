import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ShadCN-style class merge: clsx handles conditional classes, tailwind-merge
// resolves conflicting Tailwind utilities. MartBill's custom classes
// (.btn, .card, …) pass straight through untouched.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
