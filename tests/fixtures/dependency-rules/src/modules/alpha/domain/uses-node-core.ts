// VIOLATION domain-is-pure: Node I/O inside domain/.
import { readFileSync } from 'node:fs';

export function read(): string {
  return readFileSync('x', 'utf8');
}
