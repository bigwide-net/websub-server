// Subscription requests (WebSub §5): limits are checked synchronously, then the subscriber's intent is
// verified asynchronously with a GET to the callback (§5.3), and only then the subscription is stored,
// renewed or removed.
import { randomBytes } from 'crypto';
import { FeedConfig, getConfig } from './config';
import { BusyError, InvalidRequestError, LimitReachedError } from './exceptions';
import { httpRequest } from './http';
import { log } from './log';
import { time } from './server-common';
import { findSubscription, getState, removeSubscription, saveState, upsertSubscription } from './store';
import { background, createPool } from './tasks';

export interface SubscriptionRequest {
    feed: FeedConfig;
    mode: 'subscribe' | 'unsubscribe';
    topic: string;
    callback: string;
    host: string;
    leaseSeconds: number;
    secret?: string;
}

// Shared by verifications and deliveries.
export const requestPool = createPool(() => getConfig().limits.maxParallelRequests);

// Requests waiting for verification: "<feed> <topic> <callback>" -> request.
const pending = new Map<string, SubscriptionRequest & { renewal: boolean }>();

const MAX_CHALLENGE_RESPONSE_BYTES = 1024;

function countSubscriptions(feedId: string, host?: string): number {
    const stored = getState(feedId).subscriptions.filter(s => host === undefined || s.host == host).length;
    let waiting = 0;
    for (const p of pending.values())
        if (p.feed.id == feedId && p.mode == 'subscribe' && !p.renewal && (host === undefined || p.host == host)) waiting++;
    return stored + waiting;
}

function checkLimits(req: SubscriptionRequest): void {
    const { limits } = getConfig();
    if (countSubscriptions(req.feed.id) >= limits.maxSubscriptionsPerFeed)
        throw new LimitReachedError('This feed has reached its maximum number of subscriptions');
    if (countSubscriptions(req.feed.id, req.host) >= limits.maxSubscriptionsPerCallbackHost)
        throw new LimitReachedError('This feed has reached its maximum number of subscriptions for the callback host');
}

/** Accepts a validated request for verification, or throws if it can't be fulfilled. */
export function requestSubscription(req: SubscriptionRequest): void {
    const key = `${req.feed.id} ${req.topic} ${req.callback}`;
    if (pending.has(key))
        throw new InvalidRequestError('A request for this subscription is already being verified');
    if (pending.size >= getConfig().limits.maxPendingVerifications)
        throw new BusyError();
    const existing = findSubscription(req.feed.id, req.topic, req.callback);
    if (req.mode == 'unsubscribe' && !existing)
        throw new InvalidRequestError('No such subscription');
    if (req.mode == 'subscribe' && !existing)
        checkLimits(req);
    pending.set(key, { ...req, renewal: !!existing });
    background(async () => {
        try {
            await verify(req);
        } finally {
            pending.delete(key);
        }
    });
}

function callbackUrl(callback: string, params: Record<string, string>): URL {
    const url = new URL(callback);
    for (const [name, value] of Object.entries(params))
        url.searchParams.append(name, value);
    return url;
}

async function verify(req: SubscriptionRequest): Promise<void> {
    const { limits } = getConfig();
    const challenge = randomBytes(24).toString('base64url');
    const url = callbackUrl(req.callback, {
        'hub.mode': req.mode,
        'hub.topic': req.topic,
        'hub.challenge': challenge,
        ...(req.mode == 'subscribe' ? { 'hub.lease_seconds': String(req.leaseSeconds) } : {}),
    });
    let problem: string | undefined;
    try {
        const res = await requestPool(() => httpRequest(url, { method: 'GET', maxBytes: MAX_CHALLENGE_RESPONSE_BYTES, timeoutMs: limits.requestTimeoutSeconds * 1000 }));
        if (res.status < 200 || res.status > 299) problem = `status ${res.status}`;
        else if (res.body.toString('utf8').trim() != challenge) problem = 'wrong challenge';
    } catch (err: any) {
        problem = err.message;
    }
    if (problem) {
        log.info('Verification of {0} {1} for {2} failed: {3}', req.mode, req.topic, req.callback, problem);
        return;
    }

    if (req.mode == 'unsubscribe') {
        if (removeSubscription(req.feed.id, req.topic, req.callback)) await saveState(req.feed.id);
        log.info('Unsubscribed {0} from {1}', req.callback, req.topic);
        return;
    }
    // Other subscriptions may have been verified in the meantime.
    if (!findSubscription(req.feed.id, req.topic, req.callback)) {
        const state = getState(req.feed.id);
        if (state.subscriptions.length >= limits.maxSubscriptionsPerFeed
            || state.subscriptions.filter(s => s.host == req.host).length >= limits.maxSubscriptionsPerCallbackHost) {
            await deny(req, 'Subscription limit reached');
            return;
        }
    }
    const now = time.now();
    upsertSubscription(req.feed.id, {
        topic: req.topic,
        callback: req.callback,
        host: req.host,
        ...(req.secret !== undefined ? { secret: req.secret } : {}),
        leaseSeconds: req.leaseSeconds,
        expires: new Date(now.getTime() + req.leaseSeconds * 1000).toISOString(),
        created: now.toISOString(),
    });
    await saveState(req.feed.id);
    log.info('Subscribed {0} to {1} for {2}s', req.callback, req.topic, req.leaseSeconds);
}

// Informs the subscriber that the subscription was denied (§5.2). The response doesn't matter.
async function deny(req: SubscriptionRequest, reason: string): Promise<void> {
    log.info('Denied {0} for {1}: {2}', req.callback, req.topic, reason);
    const url = callbackUrl(req.callback, { 'hub.mode': 'denied', 'hub.topic': req.topic, 'hub.reason': reason });
    try {
        await requestPool(() => httpRequest(url, { method: 'GET', statusOnly: true, maxBytes: 0, timeoutMs: getConfig().limits.requestTimeoutSeconds * 1000 }));
    } catch {
        // ignored
    }
}
