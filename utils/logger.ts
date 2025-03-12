import pino from 'pino'

export const logger = pino({
    level: 'debug',
    transport: process.env.NODE_ENV !== 'local' ? undefined : {
        target: 'pino-pretty',
        options: { colorize: true }
    },
    formatters: {
        level(label) {
            return { level: label };
        }
    }
});

export class RateLimitedLogger {
    private lastLogTimes: Map<string, number> = new Map();
    private logStats: Map<string, number> = new Map();
    private logIntervalMs: number;

    constructor(logIntervalMs: number = 5000) { // Default: 5 seconds
        this.logIntervalMs = logIntervalMs;
    }

    private buildMsg(message: string, checkTime: boolean): string | null {
        const now = Date.now();
        // Extract the prefix before the first colon (`:`) or use the full message if no `:` exists
        const prefixKey = message.includes(':') ? message.split(':')[0] : message;
        const lastLogTime = this.lastLogTimes.get(prefixKey) || 0;

        this.logStats.set(prefixKey, (this.logStats.get(prefixKey) || 0) + 1);

        if (!checkTime || now - lastLogTime >= this.logIntervalMs) {
            this.lastLogTimes.set(prefixKey, now);
            return `${this.logStats.get(prefixKey)}. ${message}`;
        }
        return null;
    }


    debug(message: string, ...optionalParams: any[]) {
        const msg = this.buildMsg(message, true);
        if (msg) {
            logger.debug({ ...optionalParams }, msg);
        }
    }

    info(message: string, ...optionalParams: any[]) {
        const msg = this.buildMsg(message, false);
        if (msg) {
            logger.info({ ...optionalParams }, msg);
        }
    }

    warn(message: string, ...optionalParams: any[]) {
        const msg = this.buildMsg(message, false);
        if (msg) {
            logger.warn({ ...optionalParams }, msg);
        }
    }

    error(message: string, ...optionalParams: any[]) {
        const msg = this.buildMsg(message, false);
        if (msg) {
            logger.error({ error: optionalParams }, msg);
        }
    }    
}
