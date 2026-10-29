// VIOLATION modules-do-not-import-app: a module reaching into a route.
import Page from '@/app/page';

export function routeName(): string {
  return Page.name;
}
