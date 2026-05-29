import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const correctPassword = process.env.APP_PASSWORD;

  if (!correctPassword) {
    console.error('APP_PASSWORD is not set in environment variables.');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  if (password !== correctPassword) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });

  // 7-day persistent cookie, HttpOnly for security
  response.cookies.set('atai_auth', 'true', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    // Note: 'secure' is intentionally omitted — the app runs over HTTP on EC2.
    // If you add HTTPS/SSL in future, add: secure: true
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set('atai_auth', '', { maxAge: 0, path: '/' });
  return response;
}
