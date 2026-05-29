module.exports = {
  apps: [
    {
      name: 'atai-trend-radar',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',

      // ── Environment Variables ─────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // ── Logging ───────────────────────────────────────────────────────
      // PM2 writes its own stdout/stderr logs here (Next.js server startup, etc.)
      // Application-level logs (API requests, pipeline events) go to logs/<date>.log
      // via the custom logger in src/lib/logger.ts
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,

      // ── Restart Policy ────────────────────────────────────────────────
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
    }
  ]
};
