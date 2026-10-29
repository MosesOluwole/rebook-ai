// VIOLATION module-internals-only-via-index: reaching into another module's domain/.
import { normalise } from '../../alpha/domain/name';

export function fromAlphaInternals(): string {
  return normalise('beta');
}
