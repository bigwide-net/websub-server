// State of each feed: its subscriptions and the checksum of each topic's last distributed content.
// Kept in memory and written to $VAR/feeds/<feed id>.json after every change (temp file + rename,
// mode 0600 because it contains subscriber secrets). Read once at startup.
import { promises as fs } from 'fs';
import path from 'path';
import { Config } from './config';
import { log } from './log';
import { time } from './server-common';

export interface Subscription {
    topic: string;
    callback: string;
    // Host of the callback URL, for the per-host limit.
    host: string;
    secret?: string;
    leaseSeconds: number;
    // ISO date
    expires: string;
    created: string;
}

export interface TopicState {
    // SHA-256 (hex) of the last distributed content.
    checksum?: string;
    changed?: string;
}

export interface FeedState {
    topics: Record<string, TopicState>;
    subscriptions: Subscription[];
}

const states = new Map<string, FeedState>();
const writes = new Map<string, Promise<void>>();
let varDir = './var';

function feedFile(feedId: string): string {
    return path.join(varDir, 'feeds', `${feedId}.json`);
}

function isSubscription(s: any, topics: string[]): s is Subscription {
    return typeof s == 'object' && s !== null && topics.includes(s.topic) && typeof s.callback == 'string'
        && typeof s.host == 'string' && (s.secret === undefined || typeof s.secret == 'string')
        && Number.isInteger(s.leaseSeconds) && typeof s.expires == 'string' && !isNaN(Date.parse(s.expires))
        && typeof s.created == 'string';
}

/** Reads the state of all configured feeds. Subscriptions of topics that are no longer configured are dropped. */
export async function loadStore(config: Config): Promise<void> {
    states.clear();
    varDir = config.varDir;
    for (const feed of Object.values(config.feeds)) {
        let raw: any;
        try {
            raw = JSON.parse(await fs.readFile(feedFile(feed.id), 'utf8'));
        } catch (err: any) {
            if (err.code != 'ENOENT') throw new Error(`Cannot read state of feed ${feed.id}: ${err.message}`);
        }
        const topics: Record<string, TopicState> = {};
        for (const topic of feed.topics) {
            const t = raw?.topics?.[topic];
            topics[topic] = typeof t?.checksum == 'string' ? { checksum: t.checksum, changed: t.changed } : {};
        }
        const subscriptions = Array.isArray(raw?.subscriptions)
            ? raw.subscriptions.filter((s: any) => isSubscription(s, feed.topics)) : [];
        states.set(feed.id, { topics, subscriptions });
        if (subscriptions.length)
            log.info('Feed {0}: {1} subscriptions', feed.id, subscriptions.length);
    }
}

export function getState(feedId: string): FeedState {
    const state = states.get(feedId);
    if (!state) throw new Error(`Unknown feed ${feedId}`);
    return state;
}

/** Writes the current state of the feed. Writes of the same feed are serialized. */
export function saveState(feedId: string): Promise<void> {
    const previous = writes.get(feedId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
        const file = feedFile(feedId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(getState(feedId), null, 1), { mode: 0o600 });
        await fs.rename(tmp, file);
    });
    writes.set(feedId, result);
    result.catch(() => {}).then(() => { if (writes.get(feedId) === result) writes.delete(feedId); });
    return result;
}

export function findSubscription(feedId: string, topic: string, callback: string): Subscription | undefined {
    return getState(feedId).subscriptions.find(s => s.topic == topic && s.callback == callback);
}

/** Adds the subscription, or renews it (same topic and callback). */
export function upsertSubscription(feedId: string, sub: Subscription): void {
    const existing = findSubscription(feedId, sub.topic, sub.callback);
    if (existing) Object.assign(existing, { ...sub, created: existing.created, secret: sub.secret });
    else getState(feedId).subscriptions.push(sub);
}

export function removeSubscription(feedId: string, topic: string, callback: string): boolean {
    const state = getState(feedId);
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter(s => !(s.topic == topic && s.callback == callback));
    return state.subscriptions.length != before;
}

const isActive = (s: Subscription, now: number) => Date.parse(s.expires) > now;

export function activeSubscriptions(feedId: string, topic: string): Subscription[] {
    const now = time.now().getTime();
    return getState(feedId).subscriptions.filter(s => s.topic == topic && isActive(s, now));
}

/** Removes expired subscriptions of all feeds and writes the changed feeds. */
export async function removeExpired(): Promise<number> {
    const now = time.now().getTime();
    let removed = 0;
    for (const [feedId, state] of states) {
        const before = state.subscriptions.length;
        state.subscriptions = state.subscriptions.filter(s => isActive(s, now));
        if (state.subscriptions.length != before) {
            removed += before - state.subscriptions.length;
            await saveState(feedId);
        }
    }
    return removed;
}
