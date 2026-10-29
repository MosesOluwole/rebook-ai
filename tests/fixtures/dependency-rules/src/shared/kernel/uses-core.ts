// VIOLATION kernel-no-packages: Node I/O inside the pure kernel.
import { readFileSync } from 'node:fs';

export function read(): string {
  return readFileSync('x', 'utf8');
}
