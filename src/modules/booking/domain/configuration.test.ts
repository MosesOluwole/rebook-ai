import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/shared/kernel/validation-error';

import { parseExceptionInput, resolveException } from './availability-exception';
import { amountSchema, currencySchema } from './money';
import { parseServiceInput, serviceDefaultsFor } from './service';
import { parseDailyCapacityInput, parseServiceAreasInput, parseTeamMemberInput } from './team';
import { parseWeeklySchedule } from './working-hours';

/**
 * Phase 3 acceptance: invalid configuration is rejected with field-level errors (negative
 * durations, overlapping working-hour ranges on one day, buffers over 4 hours, price with more
 * than 2 decimals, unknown currency). The integration tests prove the same through the
 * application commands; these pin each rule and its field path.
 */

const validService = {
  name: 'Antenatal check',
  durationMinutes: '45',
  bufferBeforeMinutes: '0',
  bufferAfterMinutes: '15',
  price: '60',
  currency: 'gbp',
};

function fieldErrorsOf(run: () => unknown): Record<string, readonly string[]> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).fieldErrors;
  }
  throw new Error('expected a ValidationError');
}

describe('money', () => {
  it.each([
    ['45', '45.00'],
    ['45.5', '45.50'],
    ['045.50', '45.50'],
    ['0', '0.00'],
    ['9999999999.99', '9999999999.99'],
  ])('canonicalises %s as %s without floats', (input, output) => {
    expect(amountSchema.parse(input)).toBe(output);
  });

  it.each([
    ['45.555', 'at most 2 decimal places'],
    ['0.001', 'at most 2 decimal places'],
    ['-5', 'must not be negative'],
    ['12345678901', 'at most 9999999999.99'],
    ['4,50', 'an amount such as 45 or 45.50'],
    ['', 'an amount such as 45 or 45.50'],
    ['1e3', 'an amount such as 45 or 45.50'],
  ])('refuses %j: %s', (input, message) => {
    const result = amountSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('accepts current ISO 4217 codes in any case and refuses unknown ones', () => {
    expect(currencySchema.parse('gbp')).toBe('GBP');
    expect(currencySchema.parse(' EUR ')).toBe('EUR');
    for (const code of ['XYZ', 'DEM', 'XAU', 'GB', 'POUND', '']) {
      expect(currencySchema.safeParse(code).success, code).toBe(false);
    }
  });
});

describe('services', () => {
  it('defaults event planners to request and venue, midwives and others to timed', () => {
    expect(serviceDefaultsFor('event_planner')).toEqual({
      bookingMode: 'request',
      locationType: 'venue',
    });
    expect(serviceDefaultsFor('midwife').bookingMode).toBe('timed');
    expect(serviceDefaultsFor('other_timed').bookingMode).toBe('timed');
  });

  it('applies the defaults and starts unpublished', () => {
    const service = parseServiceInput(validService, serviceDefaultsFor('event_planner'));
    expect(service).toMatchObject({
      bookingMode: 'request',
      locationType: 'venue',
      price: '60.00',
      currency: 'GBP',
      durationMinutes: 45,
      published: false,
      repeatIntervalDays: null,
    });
  });

  it('reports every invalid field at once, keyed by field', () => {
    const errors = fieldErrorsOf(() =>
      parseServiceInput(
        {
          ...validService,
          durationMinutes: '-30',
          bufferBeforeMinutes: '241',
          bufferAfterMinutes: '-1',
          price: '10.999',
          currency: 'XYZ',
        },
        serviceDefaultsFor('midwife'),
      ),
    );
    expect(Object.keys(errors).sort()).toEqual([
      'bufferAfterMinutes',
      'bufferBeforeMinutes',
      'currency',
      'durationMinutes',
      'price',
    ]);
    expect(errors.durationMinutes).toEqual(['must be between 5 and 1440 minutes']);
    expect(errors.bufferBeforeMinutes).toEqual(['must be between 0 and 240 minutes']);
    expect(errors.bufferAfterMinutes).toEqual(['must not be negative']);
    expect(errors.price).toEqual(['at most 2 decimal places']);
  });

  it('accepts a 4-hour buffer exactly and refuses fractions of a minute', () => {
    expect(
      parseServiceInput(
        { ...validService, bufferBeforeMinutes: 240 },
        serviceDefaultsFor('midwife'),
      ).bufferBeforeMinutes,
    ).toBe(240);
    expect(
      fieldErrorsOf(() =>
        parseServiceInput(
          { ...validService, durationMinutes: '1.5' },
          serviceDefaultsFor('midwife'),
        ),
      ).durationMinutes,
    ).toBeDefined();
  });

  it('refuses unknown fields so a form cannot smuggle a column in', () => {
    expect(
      fieldErrorsOf(() =>
        parseServiceInput({ ...validService, tenantId: 'x' }, serviceDefaultsFor('midwife')),
      ),
    ).toHaveProperty('');
  });
});

describe('working hours', () => {
  it('refuses overlapping ranges on one day, with the path of the later range', () => {
    const errors = fieldErrorsOf(() =>
      parseWeeklySchedule({
        days: {
          '1': {
            ranges: [
              { start: '09:00', end: '13:00' },
              { start: '12:00', end: '17:00' },
            ],
          },
        },
      }),
    );
    expect(errors['days.1.ranges.1.start']).toEqual(['overlaps another working range on Monday']);
  });

  it('allows touching ranges and the same hours on different days', () => {
    expect(
      parseWeeklySchedule({
        days: {
          '1': {
            ranges: [
              { start: '09:00', end: '12:00' },
              { start: '12:00', end: '17:00' },
            ],
          },
          '2': { ranges: [{ start: '09:00', end: '12:00' }] },
        },
      }),
    ).toHaveLength(3);
  });

  it('refuses end before start, half-filled pairs, malformed times and 24:00 as a start', () => {
    const errors = fieldErrorsOf(() =>
      parseWeeklySchedule({
        days: {
          '1': { ranges: [{ start: '17:00', end: '09:00' }] },
          '2': { ranges: [{ start: '09:00', end: '' }] },
          '3': { ranges: [{ start: '9am', end: '17:00' }] },
          '4': { ranges: [{ start: '24:00', end: '24:00' }] },
        },
      }),
    );
    expect(errors['days.1.ranges.0.end']).toEqual(['must be after the start']);
    expect(errors['days.2.ranges.0.end']).toBeDefined();
    expect(errors['days.3.ranges.0.start']).toBeDefined();
    expect(errors['days.4.ranges.0.start']).toBeDefined();
  });

  it('ignores blank pairs and attaches each break to its range', () => {
    const [range, ...rest] = parseWeeklySchedule({
      days: {
        '5': {
          ranges: [
            { start: '', end: '' },
            { start: '08:00', end: '16:00' },
          ],
          breaks: [{ start: '12:00', end: '12:30' }],
        },
      },
    });
    expect(rest).toEqual([]);
    expect(range).toEqual({
      weekday: 5,
      start: 480,
      end: 960,
      breaks: [{ start: 720, end: 750 }],
    });
  });

  it('refuses a break outside every range and breaks that overlap', () => {
    const errors = fieldErrorsOf(() =>
      parseWeeklySchedule({
        days: {
          '1': {
            ranges: [{ start: '09:00', end: '12:00' }],
            breaks: [
              { start: '11:30', end: '12:30' },
              { start: '10:00', end: '10:30' },
              { start: '10:15', end: '10:45' },
            ],
          },
        },
      }),
    );
    expect(errors['days.1.breaks.0.start']).toEqual([
      'must fall inside a working range of the same day',
    ]);
    expect(errors['days.1.breaks.2.start']).toEqual(['overlaps another break']);
  });

  it('refuses a weekday that does not exist', () => {
    expect(fieldErrorsOf(() => parseWeeklySchedule({ days: { '8': { ranges: [] } } }))).not.toEqual(
      {},
    );
  });
});

describe('time off and closures', () => {
  const base = {
    kind: 'time_off',
    teamMemberId: '0190f3a0-0000-7000-8000-000000000001',
    locationId: '0190f3a0-0000-7000-8000-000000000002',
  };

  it('resolves local times in the location zone, earlier instant when ambiguous', () => {
    const resolved = resolveException(
      parseExceptionInput({ ...base, startsAt: '2026-10-25T01:30', endsAt: '2026-10-26T09:00' }),
      'Europe/London',
    );
    expect(resolved.startsAt.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(resolved.endsAt.toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  it('refuses a local time that does not exist, an end before the start, and a missing subject', () => {
    expect(
      fieldErrorsOf(() =>
        resolveException(
          parseExceptionInput({
            ...base,
            startsAt: '2026-03-29T01:30',
            endsAt: '2026-03-29T09:00',
          }),
          'Europe/London',
        ),
      ).startsAt,
    ).toEqual(['does not exist in Europe/London (the clocks go forward then)']);
    expect(
      fieldErrorsOf(() =>
        resolveException(
          parseExceptionInput({
            ...base,
            startsAt: '2026-05-02T10:00',
            endsAt: '2026-05-02T09:00',
          }),
          'Europe/London',
        ),
      ).endsAt,
    ).toEqual(['must be after the start']);
    expect(
      fieldErrorsOf(() =>
        parseExceptionInput({ ...base, teamMemberId: '', startsAt: 'x', endsAt: 'y' }),
      ).teamMemberId,
    ).toEqual(['time off needs a team member']);
    expect(
      fieldErrorsOf(() =>
        parseExceptionInput({ ...base, kind: 'closure', startsAt: '', endsAt: '' }),
      ).teamMemberId,
    ).toEqual(['a closure applies to everyone at the location']);
  });
});

describe('team configuration', () => {
  it('normalises postcode districts and refuses full postcodes', () => {
    expect(
      parseServiceAreasInput({
        districts: 'sw1a, m1\nB33  sw1a',
        travelBeforeMinutes: '20',
        travelAfterMinutes: '0',
      }).districts,
    ).toEqual(['B33', 'M1', 'SW1A']);
    expect(
      fieldErrorsOf(() =>
        parseServiceAreasInput({
          districts: 'SW1A 1AA',
          travelBeforeMinutes: '0',
          travelAfterMinutes: '0',
        }),
      ).districts,
    ).toBeDefined();
  });

  it('caps travel minutes at 4 hours and daily capacity between 1 and 50', () => {
    const travelErrors = fieldErrorsOf(() =>
      parseServiceAreasInput({
        districts: '',
        travelBeforeMinutes: '241',
        travelAfterMinutes: '-1',
      }),
    );
    expect(travelErrors).toHaveProperty('travelBeforeMinutes');
    expect(travelErrors).toHaveProperty('travelAfterMinutes');
    expect(parseDailyCapacityInput({ maxEventsPerDate: '3' })).toEqual({ maxEventsPerDate: 3 });
    for (const bad of ['0', '51', '-2', '1.5', '']) {
      expect(
        fieldErrorsOf(() => parseDailyCapacityInput({ maxEventsPerDate: bad })),
      ).toHaveProperty('maxEventsPerDate');
    }
  });

  it('needs a display name and accepts a blank membership', () => {
    expect(parseTeamMemberInput({ displayName: ' Ada ', membershipId: '' })).toEqual({
      displayName: 'Ada',
      membershipId: null,
    });
    expect(fieldErrorsOf(() => parseTeamMemberInput({ displayName: ' ' }))).toHaveProperty(
      'displayName',
    );
  });
});
