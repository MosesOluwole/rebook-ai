import { type Clock } from '@/shared/kernel/clock';

/** The real clock. Only infrastructure and composition roots may use it. */
export const systemClock: Clock = {
  now: () => new Date(),
};
