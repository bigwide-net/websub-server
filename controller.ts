import express from 'express';
import type QueryString from 'qs'; // type-only (QueryString.ParsedQs) — no runtime require of qs
import { initHappyServer } from '@downread/happy-server';
import { HttpError } from './lib/exceptions';
import { createRateLimitMiddleware, getClientIp } from './lib/limits.middleware';
import { IncomingHttpRequest, RawResponse } from './lib/server-common';
import { log as rootLog, LogContext } from './lib/log';
import { Config, getConfig, setConfig } from './lib/config';
import { loadStore, removeExpired } from './lib/store';
import { notificationHandler, subscribeHandler } from './handler/websub';

const EXPIRY_SWEEP_INTERVAL_MS = 3600_000;

function convertHeaders(headers: QueryString.ParsedQs | Record<string, any>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key in headers) {
        const value = headers[key];
        if (value !== undefined)
            result[key] = Array.isArray(value) ? value.join(', ') : (typeof value == 'string' ? value : '<unsupported>');
    }
    return result;
}

// The notification token must not end up in logs.
const loggablePath = (path: string) => path.replace(/^(\/websub\/notification\/).*/, '$1***');

export function wrapHandlerExpress(f: (log: LogContext, event: IncomingHttpRequest) => any): express.RequestHandler {
    const headers = {
        'Content-Type': 'application/json',
    };
    return async (req, res) => {
        const log = rootLog.sub('request');
        log.info('request', { method: req.method, path: loggablePath(req.path) });
        const event: IncomingHttpRequest = {
            body: req.body,
            queryStringParameters: convertHeaders(req.query),
            headers: convertHeaders(req.headers),
            pathParameters: req.params as Record<string, string>,
            sourceIp: getClientIp(req),
            responseHeaders: {},
        };
        try {
            const responseObject = await f(log, event);
            const status = event.responseStatus ?? 200;
            log.info('Response {0}', status);
            if (responseObject instanceof RawResponse)
                res.set({ ...event.responseHeaders, 'Content-Type': responseObject.contentType }).status(status).send(responseObject.body);
            else
                res.set({ ...headers, ...event.responseHeaders }).status(status).json(responseObject);
        }
        catch (err: any) {
            const status = err.statusCode || 500;
            if (!(err instanceof HttpError))
                log.exception(err);
            else if (status >= 500)
                log.error('{0}: {1}', err.name, err.message);
            else
                log.warning('{0}: {1}', err.name, err.message);
            const body = {
                type: err.name,
                message: (err.statusCode || process.env.DEBUG == 'true') ? err.message : 'Internal error',
                ...((err instanceof HttpError && err.extraData) ? err.extraData : {}),
                ...(process.env.DEBUG == 'true' ? { stack: err.stack } : {}),
            };
            res.set({ ...headers, ...(err instanceof HttpError ? err.headers : {}) }).status(status).json(body);
        }
        finally {
            log.close();
        }
    };
}

export function createApp(options: { happyServer?: boolean } = {}): express.Express {
    const app = express();
    app.set('trust proxy', false);
    // WebSub requests are form-encoded; notifications need no body.
    app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 20 }));
    const rateLimiter = createRateLimitMiddleware({ maxPerIpPerMinute: 30, maxPerIpPerHour: 300, maxPerIpPerDay: 2000 });
    app.use(rateLimiter);
    const finishHappyServerInit = options.happyServer !== false ? initHappyServer(app, { vitals: {} }) : undefined;

    app.get('/', (_req, res) => {
        res.send('websub-server running');
    });

    app.post('/websub/subscribe/:feed', wrapHandlerExpress(subscribeHandler));
    app.post('/websub/notification/:token', wrapHandlerExpress(notificationHandler));

    finishHappyServerInit?.();
    return app;
}

export async function startController(config: Config) {
    console.log('Starting websub-server');
    setConfig(config);
    await loadStore(config);
    setInterval(() => removeExpired().catch(err => rootLog.exception(err)), EXPIRY_SWEEP_INTERVAL_MS);
    const app = createApp();
    app.listen(getConfig().port, '0.0.0.0', () => {
        console.log(`websub-server running on http://localhost:${config.port}, public URL ${config.baseUrl}`);
    });
}
