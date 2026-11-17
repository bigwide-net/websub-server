// Publishing: after a notification, the feed's topics are fetched until their content changes, then the
// new content is delivered to all subscribers of the topic (WebSub §7).
import { createHash, createHmac } from 'crypto';
import { FeedConfig, getConfig, hubUrl } from './config';
import { TooManyRequestsError } from './exceptions';
import { fetchFeed, httpRequest } from './http';
import { log } from './log';
import { time } from './server-common';
import { activeSubscriptions, findSubscription, getState, removeSubscription, saveState, Subscription } from './store';
import { requestPool } from './subscriptions';
import { background, timing } from './tasks';

// Feeds with a running cycle -> true if another notification arrived during the cycle.
const cycles = new Map<string, boolean>();
// Times of the notification requests of the last hour, per feed.
const notificationTimes = new Map<string, number[]>();
// Number of the latest distribution per topic. Retries of older content are dropped.
const distributions = new Map<string, number>();

const HOUR = 3600_000;

/**
 * Handles a notification request of the feed's publisher: starts a check cycle, or marks the running
 * cycle to be repeated. Returns 'scheduled' or 'pending'.
 */
export function notify(feed: FeedConfig): 'scheduled' | 'pending' {
    const now = time.now().getTime();
    const times = (notificationTimes.get(feed.id) ?? []).filter(t => t > now - HOUR);
    if (times.length >= getConfig().limits.maxNotificationsPerHour)
        throw new TooManyRequestsError('Too many notifications for this feed', (times[0] + HOUR - now) / 1000);
    times.push(now);
    notificationTimes.set(feed.id, times);

    if (cycles.has(feed.id)) {
        cycles.set(feed.id, true);
        return 'pending';
    }
    startCycle(feed);
    return 'scheduled';
}

function startCycle(feed: FeedConfig): void {
    cycles.set(feed.id, false);
    background(async () => {
        try {
            await runCycle(feed);
        } finally {
            const repeat = cycles.get(feed.id);
            cycles.delete(feed.id);
            if (repeat) startCycle(feed);
        }
    });
}

// Waits notifyDelaySeconds, then checks all topics, up to 1 + maxRechecks times, until at least one of
// them has changed. Each round checks every topic, so topics that change together are distributed together.
async function runCycle(feed: FeedConfig): Promise<void> {
    const { limits } = getConfig();
    await timing.sleep(limits.notifyDelaySeconds * 1000);
    for (let check = 0; ; check++) {
        let changed = false;
        for (const topic of feed.topics)
            if (await checkTopic(feed, topic)) changed = true;
        if (changed) return;
        if (check >= limits.maxRechecks) break;
        await timing.sleep(limits.recheckIntervalSeconds * 1000);
    }
    log.info('Feed {0} unchanged after {1} rechecks', feed.id, limits.maxRechecks);
}

// A Content-Type header value from the fetched feed, if it is safe to repeat.
function contentType(value: string | undefined): string {
    return value && /^[\x20-\x7E]{1,200}$/.test(value) ? value : 'application/octet-stream';
}

// Fetches the topic. If it is fetched for the first time or has changed, it is distributed and true returned.
async function checkTopic(feed: FeedConfig, topic: string): Promise<boolean> {
    const { limits } = getConfig();
    let res;
    try {
        res = await fetchFeed(topic, limits.maxFeedBytes, limits.requestTimeoutSeconds * 1000);
    } catch (err: any) {
        log.warning('Feed {0}: cannot fetch {1}: {2}', feed.id, topic, err.message);
        return false;
    }
    if (res.status < 200 || res.status > 299) {
        log.warning('Feed {0}: fetching {1} returned status {2}', feed.id, topic, res.status);
        return false;
    }
    const checksum = createHash('sha256').update(res.body).digest('hex');
    const state = getState(feed.id).topics[topic];
    if (state.checksum == checksum) return false;
    state.checksum = checksum;
    state.changed = time.now().toISOString();
    await saveState(feed.id);
    distribute(feed, topic, res.body, contentType(res.contentType));
    return true;
}

interface Content {
    topic: string;
    body: Buffer;
    contentType: string;
    distribution: number;
}

function distribute(feed: FeedConfig, topic: string, body: Buffer, contentType: string): void {
    const distribution = (distributions.get(topic) ?? 0) + 1;
    distributions.set(topic, distribution);
    const subs = activeSubscriptions(feed.id, topic);
    log.info('Feed {0}: distributing {1} ({2} bytes) to {3} subscribers', feed.id, topic, body.length, subs.length);
    const content = { topic, body, contentType, distribution };
    for (const sub of subs)
        background(() => deliver(feed, sub, content, 0));
}

type Outcome = 'ok' | 'retry' | 'end';

async function deliver(feed: FeedConfig, sub: Subscription, content: Content, attempt: number): Promise<void> {
    const config = getConfig();
    const headers: Record<string, string> = {
        'Content-Type': content.contentType,
        'Link': `<${hubUrl(config, feed)}>; rel="hub", <${content.topic}>; rel="self"`,
    };
    if (sub.secret !== undefined)
        headers['X-Hub-Signature'] = 'sha256=' + createHmac('sha256', sub.secret).update(content.body).digest('hex');
    let outcome: Outcome, reason: string;
    try {
        const res = await requestPool(() => httpRequest(new URL(sub.callback), {
            method: 'POST', headers, body: content.body, statusOnly: true, maxBytes: 0, timeoutMs: config.limits.requestTimeoutSeconds * 1000,
        }));
        outcome = res.status >= 200 && res.status <= 299 ? 'ok' : res.status >= 500 ? 'retry' : 'end';
        reason = `status ${res.status}`;
    } catch (err: any) {
        outcome = 'retry';
        reason = err.message;
    }
    if (outcome == 'ok') return;

    if (outcome == 'retry' && attempt < config.limits.deliveryRetries) {
        log.info('Delivery of {0} to {1} failed ({2}), retrying', content.topic, sub.callback, reason);
        await timing.sleep(config.limits.deliveryRetryDelaySeconds * 1000);
        if (distributions.get(content.topic) != content.distribution) return; // newer content was delivered since
        const current = findSubscription(feed.id, sub.topic, sub.callback);
        if (current && Date.parse(current.expires) > time.now().getTime())
            await deliver(feed, current, content, attempt + 1);
        return;
    }
    log.info('Delivery of {0} to {1} failed ({2}), ending the subscription', content.topic, sub.callback, reason);
    if (removeSubscription(feed.id, sub.topic, sub.callback)) await saveState(feed.id);
}

/** Forgets running cycles, notification times and distribution counters (for tests). */
export function resetPublishing(): void {
    cycles.clear();
    notificationTimes.clear();
    distributions.clear();
}
