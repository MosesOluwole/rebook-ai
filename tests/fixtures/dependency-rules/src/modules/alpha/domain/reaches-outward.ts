// VIOLATION domain-depends-only-on-domain-and-kernel: domain importing its own application layer.
import { greet } from '../application/greet';

export function wrapped(): string {
  return greet('x');
}
