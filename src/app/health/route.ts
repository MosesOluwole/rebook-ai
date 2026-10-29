import { getHealthReport } from '@/modules/platform';

// Health must reflect this instance right now, never a cached or prerendered answer.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(getHealthReport(), {
    headers: { 'cache-control': 'no-store' },
  });
}
