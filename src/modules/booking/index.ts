/**
 * Booking module: services, team members, eligibility, schedules and capacity configuration
 * (docs/architecture.md §3 and §6, docs/phases.md Phase 3). From Phase 4 it also owns
 * availability and bookings.
 *
 * Every function takes the TenantTx from `withTenant`; commands check their permission first
 * (`services.manage`, `team.manage`, `schedules.manage`), reads need `workspace.view`, and
 * `listPublishedServices` is the one public read. Working hours are wall-clock rules resolved in
 * the location's IANA zone; money is a decimal string plus an ISO currency.
 */

// ---- Domain ------------------------------------------------------------------------------
export {
  EXCEPTION_KINDS,
  MAX_EXCEPTION_DAYS,
  type ExceptionKind,
} from './domain/availability-exception';
export { amountSchema, currencySchema, isIsoCurrency, type Money } from './domain/money';
export {
  BOOKING_MODES,
  LOCATION_TYPES,
  MAX_BUFFER_MINUTES,
  MAX_DURATION_MINUTES,
  MAX_REPEAT_INTERVAL_DAYS,
  MIN_DURATION_MINUTES,
  parseServiceInput,
  serviceDefaultsFor,
  type BookingMode,
  type LocationType,
  type ServiceDefaults,
  type ServiceInput,
} from './domain/service';
export { MAX_EVENTS_PER_DATE, MAX_SERVICE_AREAS, normalisePostcodeDistrict } from './domain/team';
export { isoWeekday, parseLocalDate, wallTimeToInstant, type LocalDate } from './domain/wall-clock';
export {
  formatTimeOfDay,
  MAX_BREAKS_PER_DAY,
  MAX_RANGES_PER_DAY,
  parseWeeklySchedule,
  resolveWorkingDay,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type Interval,
  type TimeRange,
  type Weekday,
  type WorkingRange,
} from './domain/working-hours';

// ---- Application --------------------------------------------------------------------------
export {
  addAvailabilityException,
  deleteAvailabilityException,
  getWorkingHours,
  listCurrentExceptions,
  replaceWorkingHours,
  workingIntervalsOn,
  type AvailabilityException,
  type StoredWorkingRange,
} from './application/schedules';
export {
  createService,
  deleteService,
  getService,
  listPublishedServices,
  listServices,
  newServiceDefaults,
  setServicePublished,
  tenantHasServices,
  updateService,
  type Service,
} from './application/services';
export {
  addOwnerAsTeamMember,
  createTeamMember,
  getDailyCapacity,
  getServiceAreas,
  getTeamMember,
  listTeamMembers,
  onboardingHooks,
  removeDailyCapacity,
  setDailyCapacity,
  setServiceAreas,
  setStaffServices,
  setTeamMemberActive,
  staffServiceIds,
  updateTeamMember,
  type DailyCapacityRule,
  type ServiceAreas,
  type TeamMember,
} from './application/team';

// ---- Infrastructure -----------------------------------------------------------------------
// Table objects are exported so later modules can declare composite foreign keys (crm's custom
// field values reference services). Never query them directly: use the functions above.
export {
  availabilityExceptions,
  dailyCapacityRules,
  services,
  staffServices,
  teamMemberServiceAreas,
  teamMembers,
  workingHourBreaks,
  workingHours,
} from './infrastructure/schema';
