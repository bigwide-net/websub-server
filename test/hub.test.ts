import { createHmac } from 'crypto';
import { statSync, readFileSync } from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../controller';
import { Config } from '../lib/config';
import { time } from '../lib/server-common';
import { getState, loadStore, removeExpired } from '../lib/store';
import { feedRoute, setup, sleeps, TestWeb, TOKEN, whenIdle } from './helpers';

const web = new TestWeb();
let config: Config, cleanup: () => void, app: ReturnType<typeof createApp>;
let FEED_XML: string, FEED_JSON: string, OTHER: string;

beforeAll(() => web.start());
afterAll(() => web.stop());

async function init(limits: any = {}, extra: any = {}) {
    cleanup?.();
    web.reset();
    ({ config, cleanup } = await setup(web, limits, extra));
    app = createApp({ happyServer: false });
    FEED_XML = `${web.base}/feed.xml`;
    FEED_JSON = `${web.base}/feed.json`;
    OTHER = `${web.base}/other.xml`;
}

beforeEach(() => init());
afterEach(() => whenIdle());
afterAll(() => cleanup());

function subscribe(fields: Record<string, string | string[]>, feed = 'blog') {
    return request(app).post(`/websub/subscribe/${feed}`).type('form').send(fields);
}

async function subscribed(callbackPath: string, extra: Record<string, string> = {}, topic = FEED_XML) {
    const res = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': topic, 'hub.callback': web.base + callbackPath, ...extra });
    expect(res.status).toBe(202);
    await whenIdle();
}

const notifyBlog = () => request(app).post(`/websub/notification/${TOKEN}`);

describe('subscribe', () => {
    it('verifies the intent and stores the subscription', async () => {
        const now = Date.now();
        const res = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb?user=1#frag` });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ status: 'pending' });
        await whenIdle();

        const [verification] = web.to('/cb');
        expect(verification.method).toBe('GET');
        expect(verification.query.get('user')).toBe('1');
        expect(verification.query.get('hub.mode')).toBe('subscribe');
        expect(verification.query.get('hub.topic')).toBe(FEED_XML);
        expect(verification.query.get('hub.challenge')).toMatch(/^[\w-]{32}$/);
        expect(verification.query.get('hub.lease_seconds')).toBe(String(10 * 24 * 3600));

        const [sub] = getState('blog').subscriptions;
        expect(sub).toMatchObject({ topic: FEED_XML, callback: `${web.base}/cb?user=1`, host: '127.0.0.1', leaseSeconds: 864000 });
        expect(Date.parse(sub.expires) - now).toBeGreaterThanOrEqual(864000 * 1000 - 1000);

        const file = path.join(config.varDir, 'feeds', 'blog.json');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions).toHaveLength(1);
    });

    it('clamps lease_seconds', async () => {
        await subscribed('/a', { 'hub.lease_seconds': '999999999' });
        await subscribed('/b', { 'hub.lease_seconds': '10' });
        expect(getState('blog').subscriptions.map(s => s.leaseSeconds)).toEqual([28 * 24 * 3600, 3600]);
        expect(web.to('/b')[0].query.get('hub.lease_seconds')).toBe('3600');
    });

    it('does not subscribe if the challenge is not echoed', async () => {
        web.routes.set('/wrong', () => ({ body: 'nope' }));
        web.routes.set('/error', () => ({ status: 404 }));
        web.routes.set('/redirect', () => ({ status: 302, headers: { Location: '/a' } }));
        await subscribed('/wrong');
        await subscribed('/error');
        await subscribed('/redirect');
        expect(getState('blog').subscriptions).toEqual([]);
        expect(web.to('/a')).toEqual([]);
    });

    it('renews an existing subscription and replaces its secret', async () => {
        await subscribed('/cb', { 'hub.secret': 's1', 'hub.lease_seconds': '7200' });
        await subscribed('/cb', { 'hub.lease_seconds': '86400' });
        const subs = getState('blog').subscriptions;
        expect(subs).toHaveLength(1);
        expect(subs[0].leaseSeconds).toBe(86400);
        expect(subs[0].secret).toBeUndefined();
    });

    it('unsubscribes after verification', async () => {
        await subscribed('/cb');
        await subscribed('/cb2', {}, FEED_JSON);
        const res = await subscribe({ 'hub.mode': 'unsubscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb` });
        expect(res.status).toBe(202);
        await whenIdle();
        expect(web.to('/cb')[1].query.get('hub.mode')).toBe('unsubscribe');
        expect(web.to('/cb')[1].query.has('hub.lease_seconds')).toBe(false);
        expect(getState('blog').subscriptions.map(s => s.callback)).toEqual([`${web.base}/cb2`]);

        const unknown = await subscribe({ 'hub.mode': 'unsubscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb` });
        expect(unknown.status).toBe(400);
    });

    it('keeps subscriptions if unsubscribing is not confirmed', async () => {
        await subscribed('/cb');
        web.routes.set('/cb', () => ({ body: 'no' }));
        await subscribe({ 'hub.mode': 'unsubscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb` });
        await whenIdle();
        expect(getState('blog').subscriptions).toHaveLength(1);
    });

    it('limits subscriptions per callback host and per feed', async () => {
        await init({ maxSubscriptionsPerFeed: 3, maxSubscriptionsPerCallbackHost: 2 });
        await subscribed('/a');
        await subscribed('/b');
        const res = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/c` });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/callback host/);
        // Renewals are not limited.
        await subscribed('/a');
        // Another host (localhost resolves to the test server too).
        const local = web.base.replace('127.0.0.1', 'localhost');
        expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${local}/c` })).status).toBe(202);
        await whenIdle();
        const full = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_JSON, 'hub.callback': `${local}/d` });
        expect(full.status).toBe(409);
        expect(full.body.message).toMatch(/maximum number of subscriptions$/);
        // Other feeds have their own limits.
        expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': OTHER, 'hub.callback': `${web.base}/x` }, 'other')).status).toBe(202);
        expect(getState('blog').subscriptions).toHaveLength(3);
    });

    it('counts pending verifications against the limits and rejects parallel requests', async () => {
        await init({ maxSubscriptionsPerFeed: 1, maxSubscriptionsPerCallbackHost: 1 });
        expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/a` })).status).toBe(202);
        expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/a` })).status).toBe(400);
        expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/b` })).status).toBe(409);
        await whenIdle();
    });

    it.each([
        ['unknown feed', 'nope', {}, 404],
        ['malformed feed', 'A..b', {}, 404],
        ['missing mode', 'blog', { 'hub.mode': undefined }, 400],
        ['bad mode', 'blog', { 'hub.mode': 'publish' }, 400],
        ['repeated mode', 'blog', { 'hub.mode': ['subscribe', 'subscribe'] }, 400],
        ['topic of another feed', 'blog', { 'hub.topic': 'OTHER' }, 400],
        ['unknown topic', 'blog', { 'hub.topic': 'https://evil.example/feed' }, 400],
        ['missing callback', 'blog', { 'hub.callback': undefined }, 400],
        ['ftp callback', 'blog', { 'hub.callback': 'ftp://cb.example/x' }, 400],
        ['callback with credentials', 'blog', { 'hub.callback': 'https://u:p@cb.example/x' }, 400],
        ['callback on the hub', 'blog', { 'hub.callback': 'https://hub.example/x' }, 400],
        ['callback with control chars', 'blog', { 'hub.callback': 'https://cb.example/\nx' }, 400],
        ['callback with bidi override', 'blog', { 'hub.callback': 'https://cb.example/‮x' }, 400],
        ['long callback', 'blog', { 'hub.callback': 'https://cb.example/' + 'x'.repeat(2100) }, 400],
        ['negative lease', 'blog', { 'hub.lease_seconds': '-5' }, 400],
        ['fractional lease', 'blog', { 'hub.lease_seconds': '1.5' }, 400],
        ['long secret', 'blog', { 'hub.secret': 'x'.repeat(200) }, 400],
        ['non-ASCII secret', 'blog', { 'hub.secret': 'gehéim' }, 400],
    ])('rejects %s', async (_name, feed, fields: any, status) => {
        const all: any = { 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb`, ...fields };
        if (all['hub.topic'] == 'OTHER') all['hub.topic'] = OTHER;
        for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
        const res = await subscribe(all, feed);
        expect(res.status).toBe(status);
        await whenIdle();
        expect(web.requests).toEqual([]);
    });

    it('rejects IP-literal callbacks without WEBSUB_ALLOW_PRIVATE_TARGETS', async () => {
        process.env.WEBSUB_ALLOW_PRIVATE_TARGETS = 'false';
        try {
            const res = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': 'http://127.0.0.1/cb' });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/IP address/);
        } finally {
            process.env.WEBSUB_ALLOW_PRIVATE_TARGETS = 'true';
        }
    });

    it('rejects secrets if the hub is not served over https', async () => {
        await init({}, { baseUrl: 'http://hub.example' });
        const res = await subscribe({ 'hub.mode': 'subscribe', 'hub.topic': FEED_XML, 'hub.callback': `${web.base}/cb`, 'hub.secret': 'abc' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/https/);
    });
});

describe('notification and distribution', () => {
    function feeds(xml = '<rss>1</rss>', json = '{"v":1}') {
        const x = feedRoute(xml), j = feedRoute(json, 'application/feed+json');
        web.routes.set('/feed.xml', x.route);
        web.routes.set('/feed.json', j.route);
        return { xml: x.state, json: j.state };
    }

    it('rejects unknown tokens', async () => {
        expect((await request(app).post('/websub/notification/unknown-token')).status).toBe(404);
        expect((await request(app).post('/websub/notification/a%2Fb')).status).toBe(404);
        expect((await request(app).get(`/websub/notification/${TOKEN}`)).status).toBe(404);
        await whenIdle();
        expect(web.requests).toEqual([]);
    });

    it('distributes on the first fetch, with Link header and signature', async () => {
        await subscribed('/cb', { 'hub.secret': 'sekrit' });
        await subscribed('/cb2', {}, FEED_JSON);
        feeds();
        web.requests = [];
        const res = await notifyBlog();
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ status: 'scheduled' });
        await whenIdle();
        expect(sleeps).toEqual([120_000]);

        const [delivery] = web.to('/cb');
        expect(delivery.method).toBe('POST');
        expect(delivery.body.toString()).toBe('<rss>1</rss>');
        expect(delivery.headers['content-type']).toBe('application/rss+xml');
        expect(delivery.headers.link).toBe(`<https://hub.example/websub/subscribe/blog>; rel="hub", <${FEED_XML}>; rel="self"`);
        expect(delivery.headers['x-hub-signature']).toBe('sha256=' + createHmac('sha256', 'sekrit').update('<rss>1</rss>').digest('hex'));

        const [jsonDelivery] = web.to('/cb2');
        expect(jsonDelivery.body.toString()).toBe('{"v":1}');
        expect(jsonDelivery.headers['x-hub-signature']).toBeUndefined();
        expect(getState('blog').topics[FEED_XML].checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rechecks an unchanged feed until it changes', async () => {
        await subscribed('/cb');
        const f = feeds();
        await notifyBlog();
        await whenIdle();
        web.requests = [];
        sleeps.length = 0;

        // Unchanged for the first three fetches, then changed.
        web.routes.set('/feed.xml', () => ({ body: ++f.xml.fetches > 4 ? '<rss>2</rss>' : '<rss>1</rss>' }));
        await notifyBlog();
        await whenIdle();
        expect(sleeps).toEqual([120_000, 60_000, 60_000, 60_000]);
        expect(web.to('/cb').map(r => r.body.toString())).toEqual(['<rss>2</rss>']);
        // The JSON topic never changed, so it was checked as often.
        expect(web.to('/feed.json')).toHaveLength(4);
    });

    it('gives up after maxRechecks', async () => {
        await init({ maxRechecks: 3, notifyDelaySeconds: 5, recheckIntervalSeconds: 7 });
        await subscribed('/cb');
        feeds();
        await notifyBlog();
        await whenIdle();
        web.requests = [];
        sleeps.length = 0;
        await notifyBlog();
        await whenIdle();
        expect(web.to('/feed.xml')).toHaveLength(4);
        expect(sleeps).toEqual([5000, 7000, 7000, 7000]);
        expect(web.to('/cb')).toEqual([]);
    });

    it('treats failed fetches as unchanged', async () => {
        await init({ maxRechecks: 2 });
        await subscribed('/cb');
        let n = 0;
        web.routes.set('/feed.xml', () => ++n < 3 ? { status: 503 } : { body: 'ok' });
        web.routes.set('/feed.json', () => ({ status: 404 }));
        await notifyBlog();
        await whenIdle();
        expect(n).toBe(3);
        expect(web.to('/cb').filter(r => r.method == 'POST')).toHaveLength(1);
    });

    it('follows one redirect when fetching', async () => {
        await subscribed('/cb');
        feeds();
        web.routes.set('/feed.xml', () => ({ status: 301, headers: { Location: '/moved.xml' } }));
        web.routes.set('/moved.xml', () => ({ body: 'moved' }));
        await notifyBlog();
        await whenIdle();
        expect(web.to('/cb').filter(r => r.method == 'POST').map(r => r.body.toString())).toEqual(['moved']);
    });

    it('coalesces notifications during a cycle into one more cycle', async () => {
        feeds();
        let release!: () => void;
        const { timing } = require('../lib/tasks');
        const original = timing.sleep;
        timing.sleep = (ms: number) => { sleeps.push(ms); return sleeps.length == 1 ? new Promise<void>(r => release = r) : Promise.resolve(); };
        try {
            expect((await notifyBlog()).body.status).toBe('scheduled');
            expect((await notifyBlog()).body.status).toBe('pending');
            expect((await notifyBlog()).body.status).toBe('pending');
            release();
            await whenIdle();
        } finally {
            timing.sleep = original;
        }
        // First cycle: fetch both topics once (first fetch). Second cycle: unchanged, 1 + 100 checks.
        expect(sleeps.filter(s => s == 120_000)).toHaveLength(2);
        expect(web.to('/feed.xml')).toHaveLength(1 + 101);
    });

    it('rate-limits notifications per feed', async () => {
        await init({ maxNotificationsPerHour: 2, maxRechecks: 0 });
        feeds();
        expect((await notifyBlog()).status).toBe(202);
        expect((await notifyBlog()).status).toBe(202);
        const res = await notifyBlog();
        expect(res.status).toBe(429);
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(3500);
        // Other feeds are not affected.
        web.routes.set('/other.xml', () => ({ body: 'o' }));
        expect((await request(app).post('/websub/notification/other-token')).status).toBe(202);
        await whenIdle();
    });

    it('ends subscriptions on 4xx and 3xx immediately', async () => {
        web.routes.set('/gone', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: 410 });
        web.routes.set('/forbidden', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: 403 });
        web.routes.set('/moved', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: 301, headers: { Location: '/ok' } });
        await subscribed('/gone');
        await subscribed('/forbidden');
        await subscribed('/moved');
        await subscribed('/ok');
        feeds();
        await notifyBlog();
        await whenIdle();
        expect(getState('blog').subscriptions.map(s => s.callback)).toEqual([`${web.base}/ok`]);
        expect(web.to('/ok').filter(r => r.method == 'POST')).toHaveLength(1);
        expect(sleeps).toEqual([120_000]);
    });

    it('retries 5xx and network errors, then ends the subscription', async () => {
        let flaky = 0;
        web.routes.set('/down', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: 503 });
        web.routes.set('/flaky', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: ++flaky == 1 ? 500 : 204 });
        await subscribed('/down');
        await subscribed('/flaky');
        // A subscriber whose server went away after subscribing.
        getState('blog').subscriptions.push({ ...getState('blog').subscriptions[0], callback: 'http://127.0.0.1:1/cb', host: '127.0.0.1' });
        feeds();
        await notifyBlog();
        await whenIdle();
        expect(web.to('/down').filter(r => r.method == 'POST')).toHaveLength(3);
        expect(web.to('/flaky').filter(r => r.method == 'POST')).toHaveLength(2);
        expect(getState('blog').subscriptions.map(s => s.callback)).toEqual([`${web.base}/flaky`]);
        expect(sleeps.filter(s => s == 300_000)).toHaveLength(2 + 1 + 2);
    });

    it('ends subscriptions on the first failure with deliveryRetries 0', async () => {
        await init({ deliveryRetries: 0 });
        web.routes.set('/down', req => req.method == 'GET' ? { body: req.query.get('hub.challenge')! } : { status: 503 });
        await subscribed('/down');
        feeds();
        await notifyBlog();
        await whenIdle();
        expect(web.to('/down').filter(r => r.method == 'POST')).toHaveLength(1);
        expect(getState('blog').subscriptions).toEqual([]);
    });

    it('skips and removes expired subscriptions', async () => {
        await subscribed('/old', { 'hub.lease_seconds': '3600' });
        await subscribed('/new');
        const realNow = time.now;
        time.now = () => new Date(Date.now() + 2 * 3600_000);
        try {
            feeds();
            await notifyBlog();
            await whenIdle();
            expect(web.to('/old').filter(r => r.method == 'POST')).toEqual([]);
            expect(web.to('/new').filter(r => r.method == 'POST')).toHaveLength(1);
            expect(await removeExpired()).toBe(1);
            expect(getState('blog').subscriptions.map(s => s.callback)).toEqual([`${web.base}/new`]);
        } finally {
            time.now = realNow;
        }
    });

    it('keeps subscriptions and checksums across restarts', async () => {
        await subscribed('/cb', { 'hub.secret': 'x' });
        feeds();
        await notifyBlog();
        await whenIdle();
        await loadStore(config);
        expect(getState('blog').subscriptions).toMatchObject([{ callback: `${web.base}/cb`, secret: 'x' }]);
    });

    it('does not redistribute unchanged content after a restart', async () => {
        await init({ maxRechecks: 0 });
        await subscribed('/cb');
        feeds();
        await notifyBlog();
        await whenIdle();
        await loadStore(config);
        web.requests = [];
        await notifyBlog();
        await whenIdle();
        expect(web.to('/feed.xml')).toHaveLength(1);
        expect(web.to('/cb')).toEqual([]);
    });
});
