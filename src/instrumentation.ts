/**
 * Runs once when a Next.js server starts, before it accepts requests.
 * Node-only work lives in instrumentation.node.ts so the Edge bundle never sees Node APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnvironmentOrExit } = await import('./instrumentation.node');
    validateEnvironmentOrExit();
  }
}
