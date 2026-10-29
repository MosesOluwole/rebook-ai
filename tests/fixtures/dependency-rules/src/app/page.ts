// VIOLATION no-module-internals-from-outside: a route importing a module's application/ layer.
import { greet } from '@/modules/alpha/application/greet';

export default function Page(): string {
  return greet('route');
}
