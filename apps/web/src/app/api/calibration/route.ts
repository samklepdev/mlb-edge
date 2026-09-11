import { NextResponse } from 'next/server';
import { calibrationBuckets, getScorecard } from '@mlb-edge/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [buckets, scorecard] = await Promise.all([calibrationBuckets(10), getScorecard()]);
    return NextResponse.json({ scorecard, buckets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
