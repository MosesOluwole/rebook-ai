// VIOLATION domain-is-pure: a framework import inside domain/.
import { NextResponse } from 'next/server';

export function respond(): NextResponse {
  return NextResponse.json({});
}
