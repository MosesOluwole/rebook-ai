import { normalise } from '../domain/name';

export function greet(name: string): string {
  return `hello ${normalise(name)}`;
}
