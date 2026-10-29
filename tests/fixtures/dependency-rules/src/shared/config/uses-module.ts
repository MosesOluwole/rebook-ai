// VIOLATION shared-does-not-depend-on-modules: shared code importing a module.
import { greet } from '@/modules/alpha';

export const greeting = greet('shared');
