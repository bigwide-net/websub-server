// Outgoing HTTP requests: feed fetches, verification GETs and content deliveries. Guards against SSRF:
// http(s) only, no credentials, no IP-literal hosts, hostnames must resolve to public addresses (checked
// inside the DNS lookup to prevent rebinding). Response bodies are size-limited, every request has a
// timeout. Only feed fetches follow (one) redirect.
import http, { IncomingHttpHeaders } from 'http';
import https from 'https';
import { isIP } from 'net';
import { safeLookup } from './safe-target';

export const MAX_REDIRECTS = 1;
const USER_AGENT = 'websub-server/1.0';

export interface HttpResult {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

export interface RequestOptions {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: Buffer;
    // Larger response bodies fail with HttpRequestError.
    maxBytes: number;
    timeoutMs: number;
    // Resolve as soon as the status is known, without reading the body.
    statusOnly?: boolean;
}

export class HttpRequestError extends Error {}

// WEBSUB_ALLOW_PRIVATE_TARGETS=true allows private addresses and IP literals (local development and tests).
export const allowPrivate = () => process.env.WEBSUB_ALLOW_PRIVATE_TARGETS == 'true';

/** Checks a URL for outgoing requests. Returns an error message, or undefined if acceptable. */
export function checkPublicUrl(s: string, name: string): string | undefined {
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return `${name} is not a valid URL`;
    }
    if (url.protocol != 'http:' && url.protocol != 'https:')
        return `${name} must be a http(s) URL`;
    if (url.username || url.password)
        return `${name} must not contain credentials`;
    if (!allowPrivate() && isIP(url.hostname.replace(/^\[|\]$/g, '')))
        return `${name} must use a host name, not an IP address`;
    return undefined;
}

export function httpRequest(url: URL, options: RequestOptions): Promise<HttpResult> {
    const problem = checkPublicUrl(url.href, 'URL');
    if (problem) return Promise.reject(new HttpRequestError(problem));
    return new Promise((resolve, reject) => {
        const client = url.protocol == 'https:' ? https : http;
        const headers: Record<string, string> = { 'User-Agent': USER_AGENT, ...options.headers };
        if (options.body) headers['Content-Length'] = String(options.body.length);
        const req = client.request(url, {
            method: options.method,
            headers,
            lookup: allowPrivate() ? undefined : (safeLookup as any),
            timeout: options.timeoutMs,
        }, res => {
            const status = res.statusCode ?? 0;
            if (options.statusOnly) {
                resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
                req.destroy();
                return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > options.maxBytes) {
                    req.destroy(new HttpRequestError(`Response exceeds ${options.maxBytes} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        const deadline = setTimeout(() => req.destroy(new HttpRequestError('Timeout')), options.timeoutMs);
        req.on('close', () => clearTimeout(deadline));
        req.on('timeout', () => req.destroy(new HttpRequestError('Timeout')));
        req.on('error', err => reject(err instanceof HttpRequestError ? err : new HttpRequestError(err.message)));
        req.end(options.body);
    });
}

export interface FeedResult {
    status: number;
    body: Buffer;
    contentType?: string;
}

/** GETs a feed, following at most MAX_REDIRECTS redirects. */
export async function fetchFeed(topic: string, maxBytes: number, timeoutMs: number): Promise<FeedResult> {
    let url = new URL(topic);
    for (let redirects = 0; ; redirects++) {
        const res = await httpRequest(url, {
            method: 'GET', maxBytes, timeoutMs,
            headers: { Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*;q=0.1' },
        });
        const location = res.headers.location;
        if (res.status < 300 || res.status >= 400 || !location)
            return { status: res.status, body: res.body, contentType: res.headers['content-type'] };
        if (redirects >= MAX_REDIRECTS)
            throw new HttpRequestError('Too many redirects');
        url = new URL(location, url);
        url.hash = '';
    }
}
