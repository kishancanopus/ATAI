import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const MAX_LOG_DAYS = 15;

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (err) {
        console.error('Failed to create logs directory:', err);
    }
}

/** Delete log files older than MAX_LOG_DAYS days */
function pruneOldLogs() {
    try {
        const files = fs.readdirSync(LOGS_DIR);
        const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;

        for (const file of files) {
            // Only touch date-stamped app logs (YYYY-MM-DD.log), not PM2 logs
            if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;

            const filePath = path.join(LOGS_DIR, file);
            const stat = fs.statSync(filePath);

            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                console.log(`[logger] Pruned old log file: ${file}`);
            }
        }
    } catch (err) {
        console.error('[logger] Failed to prune old logs:', err);
    }
}

// Run log pruning once at startup (not on every write — too expensive)
pruneOldLogs();

function getLogFile() {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `${date}.log`);
}

function formatMessage(level: string, message: string) {
    const timestamp = new Date().toISOString(); // e.g. 2026-04-20T06:51:00.000Z
    const paddedLevel = level.toUpperCase().padEnd(5);
    return `[${timestamp}] [${paddedLevel}] ${message}\n`;
}

function writeToFile(formatted: string) {
    try {
        fs.appendFileSync(getLogFile(), formatted);
    } catch {
        // Silently fail — logging should never crash the app
    }
}

export const logger = {
    info: (message: string) => {
        const formatted = formatMessage('info', message);
        console.log(formatted.trimEnd());
        writeToFile(formatted);
    },
    error: (message: string, error?: unknown) => {
        const detail = error instanceof Error
            ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
            : error !== undefined ? JSON.stringify(error) : '';
        const full = detail ? `${message} | ${detail}` : message;
        const formatted = formatMessage('error', full);
        console.error(formatted.trimEnd());
        writeToFile(formatted);
    },
    warn: (message: string) => {
        const formatted = formatMessage('warn', message);
        console.warn(formatted.trimEnd());
        writeToFile(formatted);
    },
    debug: (message: string) => {
        if (process.env.NODE_ENV !== 'production') {
            const formatted = formatMessage('debug', message);
            console.debug(formatted.trimEnd());
            writeToFile(formatted);
        }
    },
};
