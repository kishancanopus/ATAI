import { NextRequest, NextResponse } from 'next/server';

const AUTH_COOKIE = 'atai_auth';
const LOGIN_PATH = '/login';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow the login page and login API to pass through without auth check
  if (
    pathname === LOGIN_PATH ||
    pathname.startsWith('/api/auth')
  ) {
    return NextResponse.next();
  }

  // Check for the auth cookie
  const authCookie = request.cookies.get(AUTH_COOKIE);
  if (authCookie?.value === 'true') {
    return NextResponse.next();
  }

  // Redirect unauthenticated users to the login page
  const loginUrl = request.nextUrl.clone();
  
  loginUrl.pathname = LOGIN_PATH;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Apply to everything except Next.js static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
