import { NextResponse } from 'next/server';
import { clvByProp } from '@mlb-edge/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await clvByProp());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
