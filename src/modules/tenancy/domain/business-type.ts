import { z } from 'zod';

/**
 * What kind of business a tenant is (docs/architecture.md §1, docs/phases.md Phase 2). Chosen at
 * onboarding; it drives the words the back office uses and the health-data rules. Nothing else is
 * stored: terminology and the health flag are derived here.
 */
export const BUSINESS_TYPES = ['event_planner', 'midwife', 'other_timed'] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const businessTypeSchema = z.enum(BUSINESS_TYPES);

export interface Terminology {
  /** How the business type is named in the UI. */
  readonly label: string;
  /** The person being served: client or patient. */
  readonly client: string;
  readonly clients: string;
  /** The thing being booked: booking, enquiry or appointment. */
  readonly booking: string;
  readonly bookings: string;
}

const TERMINOLOGY: Readonly<Record<BusinessType, Terminology>> = {
  event_planner: {
    label: 'Event planner',
    client: 'client',
    clients: 'clients',
    booking: 'enquiry',
    bookings: 'enquiries',
  },
  midwife: {
    label: 'Midwife',
    client: 'patient',
    clients: 'patients',
    booking: 'appointment',
    bookings: 'appointments',
  },
  other_timed: {
    label: 'Other appointment-based business',
    client: 'client',
    clients: 'clients',
    booking: 'booking',
    bookings: 'bookings',
  },
};

export function terminologyFor(type: BusinessType): Terminology {
  return TERMINOLOGY[type];
}

/** Health-adjacent businesses: neutral messaging, no clinical fields, no marketing sends. */
export function isHealthBusiness(type: BusinessType): boolean {
  return type === 'midwife';
}

export function isBusinessType(value: string): value is BusinessType {
  return (BUSINESS_TYPES as readonly string[]).includes(value);
}

/**
 * Whether a business may change from one type to another (docs/architecture.md §1, §5). A
 * health business stays a health business: its patients are under the health rules, which a
 * change to a non-health type would lift. Everything else is allowed, including becoming a
 * midwife business and keeping the same type.
 */
export function canChangeBusinessType(from: BusinessType, to: BusinessType): boolean {
  return !(isHealthBusiness(from) && !isHealthBusiness(to));
}
