import { describe, expect, it } from 'vitest';

import { parseLocalDate, parseLocalDateTime, wallTimeToInstant } from './wall-clock';
import { parseWeeklySchedule, resolveWorkingDay } from './working-hours';

/**
 * Phase 3 acceptance: working hours entered as 09:00–17:00 Europe/London are stored as wall-clock
 * rules and resolve to the correct UTC instants on both sides of a DST change. UK clocks change on
 * the last Sunday of March (01:00 GMT → 02:00 BST) and of October (02:00 BST → 01:00 GMT):
 * 29 Mar and 25 Oct 2026, 28 Mar and 31 Oct 2027.
 */

const LONDON = 'Europe/London';
const everyDay = parseWeeklySchedule({
  days: Object.fromEntries(
    ['1', '2', '3', '4', '5', '6', '7'].map((day) => [
      day,
      { ranges: [{ start: '09:00', end: '17:00' }] },
    ]),
  ),
});

function day(date: string): { start: string; end: string }[] {
  return resolveWorkingDay(everyDay, date, LONDON).map((interval) => ({
    start: interval.start.toISOString(),
    end: interval.end.toISOString(),
  }));
}

describe.each([
  { year: 2026, spring: '2026-03-29', autumn: '2026-10-25' },
  { year: 2027, spring: '2027-03-28', autumn: '2027-10-31' },
])('Europe/London 09:00–17:00 around the $year changes', ({ spring, autumn }) => {
  const shift = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it(`is a last Sunday: ${spring} and ${autumn}`, () => {
    for (const date of [spring, autumn]) {
      expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(0);
      expect(Number(shift(date, 7).slice(8))).toBeLessThan(8);
    }
  });

  it('is 09:00–17:00 UTC on the Saturday before the spring change (GMT)', () => {
    const saturday = shift(spring, -1);
    expect(day(saturday)).toEqual([
      { start: `${saturday}T09:00:00.000Z`, end: `${saturday}T17:00:00.000Z` },
    ]);
  });

  it('is 08:00–16:00 UTC on the spring Sunday itself and the Monday after (BST)', () => {
    for (const date of [spring, shift(spring, 1)]) {
      expect(day(date)).toEqual([{ start: `${date}T08:00:00.000Z`, end: `${date}T16:00:00.000Z` }]);
    }
  });

  it('is 08:00–16:00 UTC on the Saturday before the autumn change (BST)', () => {
    const saturday = shift(autumn, -1);
    expect(day(saturday)).toEqual([
      { start: `${saturday}T08:00:00.000Z`, end: `${saturday}T16:00:00.000Z` },
    ]);
  });

  it('is 09:00–17:00 UTC on the autumn Sunday itself and the Monday after (GMT)', () => {
    for (const date of [autumn, shift(autumn, 1)]) {
      expect(day(date)).toEqual([{ start: `${date}T09:00:00.000Z`, end: `${date}T17:00:00.000Z` }]);
    }
  });

  it('drops a wall time inside the spring gap and takes the earlier of an autumn repeat', () => {
    const springDate = parseLocalDate(spring);
    const autumnDate = parseLocalDate(autumn);
    if (springDate === null || autumnDate === null) {
      throw new Error('bad fixture date');
    }
    expect(wallTimeToInstant(springDate, 60 + 30, LONDON)).toBeNull(); // 01:30 does not exist
    expect(wallTimeToInstant(springDate, 60 - 1, LONDON)?.toISOString()).toBe(
      `${spring}T00:59:00.000Z`,
    );
    expect(wallTimeToInstant(springDate, 120, LONDON)?.toISOString()).toBe(
      `${spring}T01:00:00.000Z`,
    );
    // 01:30 happens at 00:30Z (BST) and again at 01:30Z (GMT): the earlier wins.
    expect(wallTimeToInstant(autumnDate, 90, LONDON)?.toISOString()).toBe(
      `${autumn}T00:30:00.000Z`,
    );
  });

  it('moves a range edge inside the spring gap to the end of the gap', () => {
    const night = parseWeeklySchedule({
      days: { '7': { ranges: [{ start: '01:30', end: '04:00' }] } },
    });
    expect(
      resolveWorkingDay(night, spring, LONDON).map((i) => [
        i.start.toISOString(),
        i.end.toISOString(),
      ]),
    ).toEqual([[`${spring}T01:00:00.000Z`, `${spring}T03:00:00.000Z`]]);
  });

  it('gives a 01:00–02:00 range on the autumn Sunday two real hours (the hour repeats)', () => {
    const night = parseWeeklySchedule({
      days: { '7': { ranges: [{ start: '00:30', end: '02:00' }] } },
    });
    const [interval] = resolveWorkingDay(night, autumn, LONDON);
    expect(interval?.start.toISOString()).toBe(`${shift(autumn, -1)}T23:30:00.000Z`);
    expect(interval?.end.toISOString()).toBe(`${autumn}T02:00:00.000Z`);
  });
});

describe('resolveWorkingDay', () => {
  it('removes breaks and resolves a range ending at 24:00 to the next midnight', () => {
    const schedule = parseWeeklySchedule({
      days: {
        '1': {
          ranges: [{ start: '18:00', end: '24:00' }],
          breaks: [{ start: '20:00', end: '20:30' }],
        },
      },
    });
    expect(
      resolveWorkingDay(schedule, '2026-07-06', LONDON).map((i) => [
        i.start.toISOString(),
        i.end.toISOString(),
      ]),
    ).toEqual([
      ['2026-07-06T17:00:00.000Z', '2026-07-06T19:00:00.000Z'],
      ['2026-07-06T19:30:00.000Z', '2026-07-06T23:00:00.000Z'],
    ]);
  });

  it('uses each zone for its own location (New York in winter is UTC−5)', () => {
    expect(
      resolveWorkingDay(everyDay, '2026-01-05', 'America/New_York').map((i) =>
        i.start.toISOString(),
      ),
    ).toEqual(['2026-01-05T14:00:00.000Z']);
  });

  it('returns nothing on a weekday without rules', () => {
    const mondays = parseWeeklySchedule({
      days: { '1': { ranges: [{ start: '09:00', end: '17:00' }] } },
    });
    expect(resolveWorkingDay(mondays, '2026-07-07', LONDON)).toEqual([]);
  });
});

describe('local date parsing', () => {
  it('rejects impossible dates and times', () => {
    expect(parseLocalDate('2026-02-30')).toBeNull();
    expect(parseLocalDate('2026-2-3')).toBeNull();
    expect(parseLocalDateTime('2026-03-01T24:00')).toBeNull();
    expect(parseLocalDateTime('2026-03-01T09:30')).toEqual({
      date: { year: 2026, month: 3, day: 1 },
      minutes: 570,
    });
  });
});
