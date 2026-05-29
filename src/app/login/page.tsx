'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.replace('/');
      } else {
        const data = await res.json();
        setError(data.error || 'Incorrect password. Please try again.');
      }
    } catch {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#1a2318] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-4">
            <svg viewBox="0 0 24 24" className="w-9 h-9 text-[#C0FE72]" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
            </svg>
            <h1 className="text-2xl font-bold tracking-[0.3em] text-white">
              TREND <span className="text-[#C0FE72]">RADAR</span>
            </h1>
          </div>
          <p className="text-gray-400 text-sm tracking-wider">PRIVATE ACCESS ONLY</p>
        </div>

        {/* Card */}
        <div className="bg-[#243022] border border-white/10 rounded-2xl p-8 shadow-2xl">
          <h2 className="text-white font-semibold text-base mb-1">Enter Access Password</h2>
          <p className="text-gray-400 text-xs mb-6">This tool is private. Enter the shared password to continue.</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                autoFocus
                className="w-full bg-[#1a2318] border border-white/20 rounded-lg px-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#C0FE72] transition-colors"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 text-red-400 text-xs px-3 py-2 rounded-lg">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full bg-[#C0FE72] text-[#1a2318] font-bold py-3 rounded-lg text-sm tracking-widest hover:bg-[#d4ff8a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'VERIFYING...' : 'ENTER'}
            </button>
          </form>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          Trend Radar &copy; {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
