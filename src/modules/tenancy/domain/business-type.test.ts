import { describe, expect, it } from 'vitest';

import {
  BUSINESS_TYPES,
  businessTypeSchema,
  businessTypeChangeRefusal,
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
    // The database states the same rule once, in rebook.is_health_business_type(text), which
    // every health trigger calls; tests/integration/tenancy/health-business-type.test.ts fails if
    // the two lists disagree.
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

describe('businessTypeChangeRefusal (Phase 3)', () => {
  it('allows any permitted change while there are no services, and keeping the type always', () => {
    expect(businessTypeChangeRefusal('other_timed', 'event_planner', false)).toBeNull();
    expect(businessTypeChangeRefusal('event_planner', 'midwife', false)).toBeNull();
    expect(businessTypeChangeRefusal('midwife', 'midwife', true)).toBeNull();
  });

  it('refuses every change once services exist', () => {
    expect(businessTypeChangeRefusal('other_timed', 'event_planner', true)).toBe('services_exist');
    expect(businessTypeChangeRefusal('event_planner', 'midwife', true)).toBe('services_exist');
  });

  it('keeps the health lock first, with or without services', () => {
    expect(businessTypeChangeRefusal('midwife', 'other_timed', false)).toBe('health_lock');
    expect(businessTypeChangeRefusal('midwife', 'event_planner', true)).toBe('health_lock');
  });
});

describe('businessTypeChangeRefusal: free-text fields and health (Phase 3)', () => {
  it('refuses becoming a health business while fields barred for health exist', () => {
    expect(businessTypeChangeRefusal('event_planner', 'midwife', false, true)).toBe(
      'custom_fields',
    );
    expect(businessTypeChangeRefusal('other_timed', 'midwife', false, true)).toBe('custom_fields');
  });

  it('ignores free-text fields for changes between non-health types and without such fields', () => {
    expect(businessTypeChangeRefusal('event_planner', 'other_timed', false, true)).toBeNull();
    expect(businessTypeChangeRefusal('event_planner', 'midwife', false, false)).toBeNull();
  });

  it('reports services first when both apply', () => {
    expect(businessTypeChangeRefusal('event_planner', 'midwife', true, true)).toBe(
      'services_exist',
    );
  });
});
