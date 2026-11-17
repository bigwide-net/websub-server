import { DEFAULT_LIMITS, hubUrl, parseConfig } from '../lib/config';

const base = { baseUrl: 'https://hub.example/', feeds: { tim: { topic: 'https://tim.example/feed.xml', token: '12345678' } } };
const parse = (overrides: any = {}) => parseConfig(JSON.stringify({ ...base, ...overrides }), {});

describe('config', () => {
    it('applies defaults', () => {
        const c = parse();
        expect(c.baseUrl).toBe('https://hub.example');
        expect(c.port).toBe(3050);
        expect(c.allowSecrets).toBe(true);
        expect(c.limits).toEqual(DEFAULT_LIMITS);
        expect(c.limits.maxLeaseSeconds).toBe(28 * 24 * 3600);
        expect(c.feeds.tim).toEqual({ id: 'tim', topics: ['https://tim.example/feed.xml'], token: '12345678' });
        expect(hubUrl(c, c.feeds.tim)).toBe('https://hub.example/websub/subscribe/tim');
    });

    it('accepts JSON5 and several topics', () => {
        const c = parseConfig(`{ baseUrl: 'http://localhost:3050', feeds: { tim: { topics: ['https://Tim.example/a.xml', 'https://tim.example/a.json'], token: 'abc.DEF_~-1' } } }`, {});
        expect(c.feeds.tim.topics).toEqual(['https://tim.example/a.xml', 'https://tim.example/a.json']);
        expect(c.allowSecrets).toBe(false);
    });

    it('reads environment overrides', () => {
        const c = parseConfig(JSON.stringify(base), { WEBSUB_PORT: '4000', WEBSUB_VAR: '/tmp/x', WEBSUB_BASE_URL: 'http://h.example' });
        expect([c.port, c.varDir, c.baseUrl]).toEqual([4000, '/tmp/x', 'http://h.example']);
    });

    it.each([
        ['short token', { feeds: { tim: { topic: 'https://t.example/f', token: '1234567' } } }, /token/],
        ['token with slash', { feeds: { tim: { topic: 'https://t.example/f', token: '1234/5678' } } }, /token/],
        ['bad feed id', { feeds: { Tim: { topic: 'https://t.example/f', token: '12345678' } } }, /feed ids/],
        ['no topic', { feeds: { tim: { token: '12345678' } } }, /topic/],
        ['topic and topics', { feeds: { tim: { topic: 'https://t.example/f', topics: [], token: '12345678' } } }, /topic/],
        ['ftp topic', { feeds: { tim: { topic: 'ftp://t.example/f', token: '12345678' } } }, /http/],
        ['topic with fragment', { feeds: { tim: { topic: 'https://t.example/f#x', token: '12345678' } } }, /fragment/],
        ['unknown feed property', { feeds: { tim: { topic: 'https://t.example/f', token: '12345678', x: 1 } } }, /unknown/],
        ['no feeds', { feeds: {} }, /at least one/],
        ['duplicate token', { feeds: { a: { topic: 'https://t.example/a', token: '12345678' }, b: { topic: 'https://t.example/b', token: '12345678' } } }, /another feed/],
        ['duplicate topic', { feeds: { a: { topic: 'https://t.example/a', token: '12345678' }, b: { topic: 'https://t.example/a', token: '87654321' } } }, /another feed/],
        ['too many feeds', { limits: { maxFeeds: 1 }, feeds: { a: { topic: 'https://t.example/a', token: '12345678' }, b: { topic: 'https://t.example/b', token: '87654321' } } }, /at most 1/],
        ['unknown limit', { limits: { foo: 1 } }, /unknown limit/],
        ['limit out of range', { limits: { maxRechecks: -1 } }, /maxRechecks/],
        ['lease order', { limits: { minLeaseSeconds: 7200, defaultLeaseSeconds: 3600 } }, /LeaseSeconds/],
        ['unknown property', { foo: 1 }, /unknown property/],
    ])('rejects %s', (_name, overrides, error) => {
        expect(() => parse(overrides)).toThrow(error);
    });
});
