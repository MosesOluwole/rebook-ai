import { describe, expect, it } from 'vitest';

import {
  BUSINESS_TYPES,
  businessTypeSchema,
  canChangeBusinessType,
  isBusinessType,
  isHealthBusiness,
  terminologyFor,
} from './business-type';

describe('business types', () => {
  it('uses patient and appointment for midwives', () => {
    expect(terminologyFor('midwife')).toMatchObject({
      client: 'patient',
      clients: 'patients',
      booking: 'appointment',
      bookings: 'appointments',
    });
  });

  it('uses client and enquiry for event planners', () => {
    expect(terminologyFor('event_planner')).toMatchObject({
      client: 'client',
      booking: 'enquiry',
      bookings: 'enquiries',
    });
  });

  it('uses client and booking for other timed businesses', () => {
    expect(terminologyFor('other_timed')).toMatchObject({ client: 'client', booking: 'booking' });
  });

  it('marks only midwives as health businesses', () => {
    expect(BUSINESS_TYPES.filter(isHealthBusiness)).toEqual(['midwife']);
  });

  it('rejects anything outside the three types', () => {
    expect(businessTypeSchema.safeParse('salon').success).toBe(false);
    expect(businessTypeSchema.safeParse('Midwife').success).toBe(false);
    expect(isBusinessType('midwife')).toBe(true);
    expect(isBusinessType('')).toBe(false);
  });

  it.each([
    ['midwife', 'event_planner', false],
    ['midwife', 'other_timed', false],
    ['midwife', 'midwife', true],
    ['event_planner', 'midwife', true],
    ['other_timed', 'midwife', true],
    ['event_planner', 'other_timed', true],
    ['other_timed', 'event_planner', true],
    ['event_planner', 'event_planner', true],
  ] as const)('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canChangeBusinessType(from, to)).toBe(allowed);
  });
});
