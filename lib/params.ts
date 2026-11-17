// Checks for request parameters (path and form body). Each check returns the validated, normalized value
// or throws. Modeled after rssmention/lib/params.ts.
import { timingSafeEqual, createHash } from 'crypto';
import { Config, FEED_ID_PATTERN, FeedConfig, Limits, MAX_TOKEN_LENGTH, TOKEN_PATTERN } from './config';
import { InvalidRequestError, NotFoundError } from './exceptions';
import { checkPublicUrl } from './http';
import { hasForbiddenChars, isPrintableAscii } from './sanitize';

export const MAX_URL_PARAM_LENGTH = 2048;
// The spec requires hub.secret to be less than 200 bytes.
export const MAX_SECRET_BYTES = 199;

/** A configured feed by its id (path parameter). Unknown or malformed ids are 404. */
export function checkFeedId(config: Config, s: unknown): FeedConfig {
    if (typeof s != 'string' || !FEED_ID_PATTERN.test(s) || !Object.hasOwn(config.feeds, s))
        throw new NotFoundError('Unknown feed');
    return config.feeds[s];
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The feed with the given notification token (path parameter). Compared in constant time; unknown tokens are 404. */
export function checkToken(config: Config, s: unknown): FeedConfig {
    if (typeof s != 'string' || s.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(s))
        throw new NotFoundError('Unknown token');
    const given = digest(s);
    let found: FeedConfig | undefined;
    for (const feed of Object.values(config.feeds))
        if (timingSafeEqual(given, digest(feed.token))) found = feed;
    if (!found) throw new NotFoundError('Unknown token');
    return found;
}

/** A single string form field. Repeated fields (arrays) are rejected. */
function formString(v: unknown, name: string, optional: true): string | undefined;
function formString(v: unknown, name: string, optional?: false): string;
function formString(v: unknown, name: string, optional = false): string | undefined {
    if (v === undefined && optional) return undefined;
    if (v === undefined || v === '') throw new InvalidRequestError(`Missing parameter ${name}`);
    if (typeof v != 'string') throw new InvalidRequestError(`Parameter ${name} must be given once`);
    return v;
}

export function checkMode(v: unknown): 'subscribe' | 'unsubscribe' {
    const mode = formString(v, 'hub.mode');
    if (mode != 'subscribe' && mode != 'unsubscribe')
        throw new InvalidRequestError('hub.mode must be subscribe or unsubscribe');
    return mode;
}

/** A URL parameter without control or invisible characters, normalized to its (ASCII) href. */
function urlParam(v: unknown, name: string): URL {
    const s = formString(v, name).trim();
    if (s.length > MAX_URL_PARAM_LENGTH)
        throw new InvalidRequestError(`Parameter ${name} is too long`);
    if (hasForbiddenChars(s))
        throw new InvalidRequestError(`Parameter ${name} contains invalid characters`);
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        throw new InvalidRequestError(`${name} is not a valid URL`);
    }
    if (url.href.length > MAX_URL_PARAM_LENGTH)
        throw new InvalidRequestError(`Parameter ${name} is too long`);
    return url;
}

/** hub.topic: must be one of the feed's topics. */
export function checkTopic(feed: FeedConfig, v: unknown): string {
    const topic = urlParam(v, 'hub.topic').href;
    if (!feed.topics.includes(topic))
        throw new InvalidRequestError('hub.topic is not a topic of this hub URL');
    return topic;
}

/** hub.callback: a public http(s) URL, not on this server. The fragment is removed. */
export function checkCallback(config: Config, v: unknown): { callback: string, host: string } {
    const url = urlParam(v, 'hub.callback');
    url.hash = '';
    const problem = checkPublicUrl(url.href, 'hub.callback');
    if (problem) throw new InvalidRequestError(problem);
    if (url.host == new URL(config.baseUrl).host)
        throw new InvalidRequestError('hub.callback must not be on this server');
    return { callback: url.href, host: url.hostname };
}

/** hub.lease_seconds: optional, clamped to the configured range. */
export function checkLeaseSeconds(limits: Limits, v: unknown): number {
    const s = formString(v, 'hub.lease_seconds', true);
    if (s === undefined) return limits.defaultLeaseSeconds;
    if (!/^\d{1,12}$/.test(s))
        throw new InvalidRequestError('hub.lease_seconds must be a positive integer');
    return Math.min(limits.maxLeaseSeconds, Math.max(limits.minLeaseSeconds, Number(s)));
}

/** hub.secret: optional, printable ASCII of less than 200 bytes, only if the hub is served over https. */
export function checkSecret(config: Config, v: unknown): string | undefined {
    const secret = formString(v, 'hub.secret', true);
    if (secret === undefined) return undefined;
    if (!config.allowSecrets)
        throw new InvalidRequestError('hub.secret requires https');
    if (!isPrintableAscii(secret, MAX_SECRET_BYTES))
        throw new InvalidRequestError(`hub.secret must be printable ASCII of at most ${MAX_SECRET_BYTES} characters`);
    return secret;
}
