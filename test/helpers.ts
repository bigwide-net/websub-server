import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Config, parseConfig, setConfig } from '../lib/config';
import { resetPublishing } from '../lib/publish';
import { loadStore } from '../lib/store';
import { timing, whenIdle } from '../lib/tasks';

process.env.WEBSUB_ALLOW_PRIVATE_TARGETS = 'true';

export const BASE = 'https://hub.example';
export const TOKEN = 'tok-12345';

export interface Recorded {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

export type Route = (req: Recorded) => { status?: number, body?: string | Buffer, headers?: Record<string, string> };

// A local web server playing publisher (feeds) and subscribers (callbacks).
export class TestWeb {
    server!: http.Server;
    base = '';
    requests: Recorded[] = [];
    routes = new Map<string, Route>();

    async start() {
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const url = new URL(req.url!, 'http://x');
                const rec: Recorded = { method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
                this.requests.push(rec);
                const route = this.routes.get(url.pathname) ?? echoChallenge;
                const r = route(rec);
                res.writeHead(r.status ?? 200, r.headers);
                res.end(r.body ?? '');
            });
        });
        await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
        this.base = `http://127.0.0.1:${(this.server.address() as any).port}`;
    }

    stop() {
        return new Promise(r => this.server.close(r));
    }

    reset() {
        this.requests = [];
        this.routes.clear();
    }

    to(p: string) {
        return this.requests.filter(r => r.path == p);
    }
}

/** Default route: subscribers that confirm verifications and accept deliveries. */
export const echoChallenge: Route = req => req.method == 'GET' ? { body: req.query.get('hub.challenge') ?? '' } : { status: 200 };

/** A feed route whose content can be changed. */
export function feedRoute(initial: string, contentType = 'application/rss+xml') {
    const state = { content: initial, fetches: 0 };
    const route: Route = () => {
        state.fetches++;
        return { body: state.content, headers: { 'Content-Type': contentType } };
    };
    return { state, route };
}

export const sleeps: number[] = [];
timing.sleep = async (ms: number) => { sleeps.push(ms); };

export async function setup(web: TestWeb, limits: any = {}, extra: any = {}): Promise<{ config: Config, cleanup: () => void }> {
    const varDir = mkdtempSync(path.join(os.tmpdir(), 'websub-test-'));
    const config = parseConfig(JSON.stringify({
        baseUrl: extra.baseUrl ?? BASE,
        limits,
        feeds: {
            blog: { topics: [`${web.base}/feed.xml`, `${web.base}/feed.json`], token: TOKEN },
            other: { topic: `${web.base}/other.xml`, token: 'other-token' },
        },
    }), { WEBSUB_VAR: varDir });
    setConfig(config);
    await loadStore(config);
    resetPublishing();
    sleeps.length = 0;
    return { config, cleanup: () => rmSync(varDir, { recursive: true, force: true }) };
}

export { whenIdle };
