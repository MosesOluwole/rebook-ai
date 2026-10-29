// Allowed: another module through its index.ts.
import { greet } from '../../alpha';

export function fromAlphaPublic(): string {
  return greet('beta');
}
