// The static configuration (JSON5 file). Feeds can only be added or changed by editing it and restarting.
import { readFileSync } from 'fs';
import JSON5 from 'json5';
import { hasForbiddenChars } from './sanitize';

export interface Limits {
    maxFeeds: number;
    // Subscriptions per feed (all its topics), and per callback host and feed.
    maxSubscriptionsPerFeed: number;
    maxSubscriptionsPerCallbackHost: number;
    // After a notification, wait this long before fetching the feed.
    notifyDelaySeconds: number;
    // If the feed is unchanged, fetch again after this interval, at most maxRechecks times.
    recheckIntervalSeconds: number;
    maxRechecks: number;
    // Notification requests per feed and hour; more get 429.
    maxNotificationsPerHour: number;
    defaultLeaseSeconds: number;
    minLeaseSeconds: number;
    maxLeaseSeconds: number;
    maxFeedBytes: number;
    // Timeout of every outgoing request (feed fetch, verification, delivery).
    requestTimeoutSeconds: number;
    // Outgoing verification and delivery requests running at the same time.
    maxParallelRequests: number;
    // Subscription requests waiting for verification (all feeds); more get 503.
    maxPendingVerifications: number;
    // A delivery that fails with 5xx, a timeout or a network error is retried this often before the
    // subscription ends. Any other non-2xx response ends it immediately. 0: end on the first failure.
    deliveryRetries: number;
    deliveryRetryDelaySeconds: number;
}

export interface FeedConfig {
    id: string;
    // The topic URLs of the feed, e.g. its RSS and JSON versions. Each is a separate WebSub topic, but a
    // notification checks all of them.
    topics: string[];
    // Secret path segment of the notification endpoint /websub/notification/<token>.
    token: string;
}

export interface Config {
    port: number;
    // Public URL of this service, without trailing slash.
    baseUrl: string;
    varDir: string;
    // hub.secret is accepted only if baseUrl is https (the spec forbids secrets over plain http).
    allowSecrets: boolean;
    limits: Limits;
    feeds: Record<string, FeedConfig>;
}

const DAY = 24 * 3600;

export const DEFAULT_LIMITS: Limits = {
    maxFeeds: 100,
    maxSubscriptionsPerFeed: 1000,
    maxSubscriptionsPerCallbackHost: 10,
    notifyDelaySeconds: 120,
    recheckIntervalSeconds: 60,
    maxRechecks: 100,
    maxNotificationsPerHour: 30,
    defaultLeaseSeconds: 10 * DAY,
    minLeaseSeconds: 3600,
    maxLeaseSeconds: 28 * DAY,
    maxFeedBytes: 2 * 1024 * 1024,
    requestTimeoutSeconds: 10,
    maxParallelRequests: 10,
    maxPendingVerifications: 1000,
    deliveryRetries: 2,
    deliveryRetryDelaySeconds: 300,
};

// Allowed range of each limit.
const LIMIT_RANGES: Record<keyof Limits, [number, number]> = {
    maxFeeds: [1, 10000],
    maxSubscriptionsPerFeed: [1, 1_000_000],
    maxSubscriptionsPerCallbackHost: [1, 1_000_000],
    notifyDelaySeconds: [0, DAY],
    recheckIntervalSeconds: [1, DAY],
    maxRechecks: [0, 10000],
    maxNotificationsPerHour: [1, 3600],
    defaultLeaseSeconds: [60, 365 * DAY],
    minLeaseSeconds: [60, 365 * DAY],
    maxLeaseSeconds: [60, 365 * DAY],
    maxFeedBytes: [1024, 100 * 1024 * 1024],
    requestTimeoutSeconds: [1, 120],
    maxParallelRequests: [1, 1000],
    maxPendingVerifications: [1, 1_000_000],
    deliveryRetries: [0, 10],
    deliveryRetryDelaySeconds: [1, DAY],
};

export const MAX_TOPIC_LENGTH = 2048;
export const MAX_TOPICS_PER_FEED = 10;
export const MIN_TOKEN_LENGTH = 8;
export const MAX_TOKEN_LENGTH = 256;
// Tokens are used as path segment, so only URL-safe characters are allowed.
export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
export const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message: string): never {
    throw new Error(`Invalid config: ${message}`);
}

function parseLimits(raw: any): Limits {
    if (raw === undefined) raw = {};
    if (typeof raw != 'object' || raw === null || Array.isArray(raw)) fail('limits must be an object');
    for (const key of Object.keys(raw))
        if (!Object.hasOwn(DEFAULT_LIMITS, key)) fail(`unknown limit ${key}`);
    const limits = { ...DEFAULT_LIMITS, ...raw } as Limits;
    for (const [key, [min, max]] of Object.entries(LIMIT_RANGES) as [keyof Limits, [number, number]][]) {
        const v = limits[key];
        if (!Number.isInteger(v) || v < min || v > max) fail(`limits.${key} must be an integer from ${min} to ${max}`);
    }
    if (!(limits.minLeaseSeconds <= limits.defaultLeaseSeconds && limits.defaultLeaseSeconds <= limits.maxLeaseSeconds))
        fail('limits must satisfy minLeaseSeconds <= defaultLeaseSeconds <= maxLeaseSeconds');
    if (limits.maxSubscriptionsPerCallbackHost > limits.maxSubscriptionsPerFeed)
        fail('limits.maxSubscriptionsPerCallbackHost must not exceed maxSubscriptionsPerFeed');
    return limits;
}

/** An absolute http(s) URL without credentials or fragment, normalized to its href. */
export function parseHttpUrl(where: string, value: any): string {
    if (typeof value != 'string' || !value || value.length > MAX_TOPIC_LENGTH || hasForbiddenChars(value))
        fail(`${where} must be a URL of at most ${MAX_TOPIC_LENGTH} characters`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        fail(`${where} is not a valid URL`);
    }
    if (url.protocol != 'http:' && url.protocol != 'https:') fail(`${where} must be a http(s) URL`);
    if (url.username || url.password) fail(`${where} must not contain credentials`);
    if (url.hash) fail(`${where} must not contain a fragment`);
    return url.href;
}

function parseFeed(id: string, raw: any): FeedConfig {
    const where = `feeds.${id}`;
    if (!FEED_ID_PATTERN.test(id)) fail(`${where}: feed ids must match ${FEED_ID_PATTERN}`);
    if (typeof raw != 'object' || raw === null || Array.isArray(raw)) fail(`${where} must be an object`);
    for (const key of Object.keys(raw))
        if (!['topic', 'topics', 'token'].includes(key)) fail(`${where}: unknown property ${key}`);
    if ((raw.topic === undefined) == (raw.topics === undefined)) fail(`${where} needs either topic or topics`);
    const rawTopics = raw.topic !== undefined ? [raw.topic] : raw.topics;
    if (!Array.isArray(rawTopics) || !rawTopics.length || rawTopics.length > MAX_TOPICS_PER_FEED)
        fail(`${where}.topics must be a list of 1 to ${MAX_TOPICS_PER_FEED} URLs`);
    const topics = rawTopics.map((t: any, i: number) => parseHttpUrl(`${where}.topics[${i}]`, t));
    if (new Set(topics).size != topics.length) fail(`${where}.topics contains duplicates`);
    const token = raw.token;
    if (typeof token != 'string' || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token))
        fail(`${where}.token must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters of A-Z, a-z, 0-9, ".", "_", "~" and "-"`);
    return { id, topics, token };
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Config {
    let raw: any;
    try {
        raw = JSON5.parse(text);
    } catch (err: any) {
        fail(err.message);
    }
    if (typeof raw != 'object' || raw === null || Array.isArray(raw)) fail('must be an object');
    for (const key of Object.keys(raw))
        if (!['port', 'baseUrl', 'varDir', 'limits', 'feeds'].includes(key)) fail(`unknown property ${key}`);

    const baseUrl = parseHttpUrl('baseUrl', env.WEBSUB_BASE_URL || raw.baseUrl).replace(/\/+$/, '');
    const port = Number(env.WEBSUB_PORT) || raw.port || 3050;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port must be a valid port number');
    const varDir = env.WEBSUB_VAR || raw.varDir || './var';
    if (typeof varDir != 'string') fail('varDir must be a string');
    const limits = parseLimits(raw.limits);

    if (typeof raw.feeds != 'object' || raw.feeds === null || Array.isArray(raw.feeds)) fail('feeds must be an object');
    const ids = Object.keys(raw.feeds);
    if (!ids.length) fail('at least one feed is required');
    if (ids.length > limits.maxFeeds) fail(`at most ${limits.maxFeeds} feeds are allowed (limits.maxFeeds)`);
    const feeds: Record<string, FeedConfig> = {};
    const tokens = new Set<string>(), topics = new Set<string>();
    for (const id of ids) {
        const feed = parseFeed(id, raw.feeds[id]);
        if (tokens.has(feed.token)) fail(`feeds.${id}.token is used by another feed`);
        tokens.add(feed.token);
        for (const topic of feed.topics) {
            if (topics.has(topic)) fail(`feeds.${id}: topic ${topic} is used by another feed`);
            topics.add(topic);
        }
        feeds[id] = feed;
    }
    return { port, baseUrl, varDir, allowSecrets: baseUrl.startsWith('https:'), limits, feeds };
}

export function loadConfig(path = process.env.WEBSUB_CONFIG || './websub.json5'): Config {
    return parseConfig(readFileSync(path, 'utf8'));
}

/** The hub URL that the feed must announce (atom:link rel="hub" / JSON Feed hubs). */
export function hubUrl(config: Config, feed: FeedConfig): string {
    return `${config.baseUrl}/websub/subscribe/${feed.id}`;
}

// The active configuration. Set once at startup (or by tests).
let currentConfig: Config | undefined;

export function setConfig(config: Config) {
    currentConfig = config;
}

export function getConfig(): Config {
    if (!currentConfig) throw new Error('Config not initialized');
    return currentConfig;
}
