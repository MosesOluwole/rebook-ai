import {
  BOOKING_MODES,
  type BookingMode,
  LOCATION_TYPES,
  type LocationType,
  MAX_BUFFER_MINUTES,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  type Service,
  type ServiceDefaults,
} from '@/modules/booking';

import { SelectInput, TextInput } from '../../../_components/forms';

export const BOOKING_MODE_LABELS: Readonly<Record<BookingMode, string>> = {
  timed: 'Timed appointment (booked on a slot)',
  request: 'Request (the client enquires, you accept)',
};

export const LOCATION_TYPE_LABELS: Readonly<Record<LocationType, string>> = {
  clinic: 'At your clinic',
  client_home: "At the client's home",
  video: 'By video',
  venue: 'At a venue',
};

/**
 * The service form's fields, shared by "new" and "edit"; rendered inside an ActionForm, whose state
 * re-fills them after an error. Validation happens on the server; min, max and step are a
 * convenience only. The price is a decimal with at most two places, never parsed into a float here.
 */
export function ServiceFields({
  defaults,
  service,
  disabled,
}: {
  readonly defaults: ServiceDefaults;
  readonly service?: Service;
  readonly disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="muted">Service details</legend>
      <div className="day">
        <TextInput name="name" label="Name" required maxLength={120} defaultValue={service?.name} />
        <SelectInput
          name="bookingMode"
          label="Booking mode"
          defaultValue={service?.bookingMode ?? defaults.bookingMode}
          options={BOOKING_MODES.map((mode) => ({ value: mode, label: BOOKING_MODE_LABELS[mode] }))}
        />
        <SelectInput
          name="locationType"
          label="Where"
          defaultValue={service?.locationType ?? defaults.locationType}
          options={LOCATION_TYPES.map((type) => ({
            value: type,
            label: LOCATION_TYPE_LABELS[type],
          }))}
        />
        <div className="row">
          <TextInput
            type="number"
            name="durationMinutes"
            label="Duration (minutes)"
            inputMode="numeric"
            min={MIN_DURATION_MINUTES}
            max={MAX_DURATION_MINUTES}
            step={1}
            required
            defaultValue={service?.durationMinutes ?? 60}
          />
          <TextInput
            type="number"
            name="bufferBeforeMinutes"
            label="Buffer before (minutes)"
            inputMode="numeric"
            min={0}
            max={MAX_BUFFER_MINUTES}
            step={1}
            defaultValue={service?.bufferBeforeMinutes ?? 0}
          />
          <TextInput
            type="number"
            name="bufferAfterMinutes"
            label="Buffer after (minutes)"
            inputMode="numeric"
            min={0}
            max={MAX_BUFFER_MINUTES}
            step={1}
            defaultValue={service?.bufferAfterMinutes ?? 0}
          />
        </div>
        <div className="row">
          {/* Text, not number: the browser must not round or reformat the decimal. */}
          <TextInput
            name="price"
            label="Price"
            inputMode="decimal"
            required
            placeholder="45.00"
            defaultValue={service?.price ?? ''}
          />
          <TextInput
            name="currency"
            label="Currency (e.g. GBP)"
            required
            autoCapitalize="characters"
            defaultValue={service?.currency ?? 'GBP'}
          />
          <TextInput
            type="number"
            name="repeatIntervalDays"
            label="Repeat every (days, optional)"
            inputMode="numeric"
            min={1}
            step={1}
            defaultValue={service?.repeatIntervalDays ?? ''}
          />
        </div>
      </div>
    </fieldset>
  );
}
