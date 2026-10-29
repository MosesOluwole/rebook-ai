import { type Clock } from '@/shared/kernel/clock';

export type Name = string;

// Allowed: own domain + shared kernel + zod.
export function normalise(name: Name, _clock?: Clock): Name {
  return name.trim();
}
