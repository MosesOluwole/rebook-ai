'use client';

import { useState } from 'react';

import { useFieldError } from '../../../../_components/forms';

/**
 * The weekly hours of one team member at one location. Every stored range and break is rendered,
 * so a save never drops what is already there (Phase 3 decisions); ranges and breaks can be added
 * up to the domain maximum and removed. The inputs are controlled, so they keep what was typed
 * when the server refuses the week; a successful save remounts the editor with the stored rules
 * (the page keys it by them). Without JavaScript the stored rows and one empty pair per empty day
 * still post as before.
 */

export interface TimePair {
  readonly start: string;
  readonly end: string;
}

export interface DayRules {
  readonly ranges: readonly TimePair[];
  readonly breaks: readonly TimePair[];
}

const EMPTY: TimePair = { start: '', end: '' };

function PairInputs({
  name,
  label,
  pair,
  disabled,
  onChange,
  onRemove,
}: {
  readonly name: string;
  readonly label: string;
  readonly pair: TimePair;
  readonly disabled: boolean;
  readonly onChange: (pair: TimePair) => void;
  readonly onRemove: () => void;
}) {
  const start = useFieldError(`${name}.start`);
  const end = useFieldError(`${name}.end`);
  return (
    <div className="pair">
      <label>
        {label} from
        <input
          type="time"
          name={`${name}.start`}
          value={pair.start}
          onChange={(event) => {
            onChange({ ...pair, start: event.target.value });
          }}
          {...start.aria}
        />
        {start.message}
      </label>
      <label>
        {label} to
        {/* Text: time inputs cannot express 24:00 (midnight at the end of the day). */}
        <input
          type="text"
          name={`${name}.end`}
          inputMode="numeric"
          placeholder="17:00"
          pattern="[0-2][0-9]:[0-5][0-9]"
          value={pair.end}
          onChange={(event) => {
            onChange({ ...pair, end: event.target.value });
          }}
          {...end.aria}
        />
        {end.message}
      </label>
      {!disabled && (
        <button type="button" className="quiet" onClick={onRemove}>
          Remove {label.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function DayEditor({
  weekday,
  name,
  initial,
  maxRanges,
  maxBreaks,
  disabled,
}: {
  readonly weekday: number;
  readonly name: string;
  readonly initial: DayRules;
  readonly maxRanges: number;
  readonly maxBreaks: number;
  readonly disabled: boolean;
}) {
  // An empty day shows one empty pair, so it can be filled in without JavaScript.
  const [ranges, setRanges] = useState<TimePair[]>(
    initial.ranges.length > 0 ? [...initial.ranges] : [EMPTY],
  );
  const [breaks, setBreaks] = useState<TimePair[]>(
    initial.breaks.length > 0 ? [...initial.breaks] : [EMPTY],
  );
  const update =
    (list: TimePair[], set: (next: TimePair[]) => void, index: number) => (pair: TimePair) => {
      set(list.map((item, i) => (i === index ? pair : item)));
    };
  // Removing the last row empties it instead, so a day off is "both times blank".
  const remove = (list: TimePair[], set: (next: TimePair[]) => void, index: number) => () => {
    set(list.length === 1 ? [EMPTY] : list.filter((_, i) => i !== index));
  };
  const prefix = `days.${String(weekday)}`;

  return (
    <fieldset aria-label={name}>
      <legend>{name}</legend>
      {ranges.map((pair, index) => (
        <PairInputs
          key={`r${String(index)}`}
          name={`${prefix}.ranges.${String(index)}`}
          label={index === 0 ? 'Hours' : `Hours ${String(index + 1)}`}
          pair={pair}
          disabled={disabled}
          onChange={update(ranges, setRanges, index)}
          onRemove={remove(ranges, setRanges, index)}
        />
      ))}
      {breaks.map((pair, index) => (
        <PairInputs
          key={`b${String(index)}`}
          name={`${prefix}.breaks.${String(index)}`}
          label={index === 0 ? 'Break' : `Break ${String(index + 1)}`}
          pair={pair}
          disabled={disabled}
          onChange={update(breaks, setBreaks, index)}
          onRemove={remove(breaks, setBreaks, index)}
        />
      ))}
      {!disabled && (
        <div className="actions">
          {ranges.length < maxRanges && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setRanges([...ranges, EMPTY]);
              }}
            >
              Add hours on {name}
            </button>
          )}
          {breaks.length < maxBreaks && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setBreaks([...breaks, EMPTY]);
              }}
            >
              Add a break on {name}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}

export function HoursEditor({
  days,
  maxRanges,
  maxBreaks,
  disabled,
}: {
  /** Weekday (1 = Monday) → its name and stored rules, in week order. */
  readonly days: readonly {
    readonly weekday: number;
    readonly name: string;
    readonly rules: DayRules;
  }[];
  readonly maxRanges: number;
  readonly maxBreaks: number;
  readonly disabled: boolean;
}) {
  const formLevel = useFieldError('');
  return (
    <fieldset disabled={disabled}>
      <legend className="muted">Leave a day blank for a day off</legend>
      {formLevel.message}
      <div className="day">
        {days.map((day) => (
          <DayEditor
            key={day.weekday}
            weekday={day.weekday}
            name={day.name}
            initial={day.rules}
            maxRanges={maxRanges}
            maxBreaks={maxBreaks}
            disabled={disabled}
          />
        ))}
      </div>
    </fieldset>
  );
}
