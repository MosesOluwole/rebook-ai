// VIOLATION domain-depends-only-on-domain-and-kernel: domain importing another module, even
// through that module's index.ts.
import { fromAlphaPublic } from '../../beta';

export function viaBeta(): string {
  return fromAlphaPublic();
}
