// The parts of the client the shared corpus does not reach: what goes onto the
// wire, how each response is unwrapped, and what is worth a retry.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_BASE_URL, InternetData, InternetDataError } from '../dist/index.js';

const KEY = 'test-key';

const CHECKSUMS = {
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
    sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    sha512: 'cf83e1357eefb8bd',
};

const METADATA = {
    id: 'small_v1',
    update_freq: 'daily',
    updated: '2026-09-04',
    entries: 42,
    schema: { csvgz: [{ name: 'asn', type: 'int' }] },
    size: { csvgz: 264 },
};

function stub(replies) {
    const calls = [];
    const queue = Array.isArray(replies) ? [...replies] : null;
    const fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const headers = input?.headers ?? new Headers(init?.headers ?? {});
        calls.push({ url: new URL(url), authorization: headers.get('authorization') });
        const r = queue === null ? replies : (queue.shift() ?? replies[replies.length - 1]);
        return new Response(JSON.stringify(r.body ?? {}), {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        });
    };
    return { calls: calls, fetch: fetch };
}

function clientFor(replies, options = {}) {
    const s = stub(replies);
    return {
        calls: s.calls,
        client: new InternetData({ apiKey: KEY, fetch: s.fetch, retries: 0, ...options }),
    };
}

test('a missing or empty key is refused at construction', () => {
    // An empty key is sent as NO auth header at all, so without this the API
    // answers 401 and every keyed assertion downstream passes vacuously. This is
    // exactly what an unset CI secret interpolates to.
    assert.throws(() => new InternetData({ apiKey: '' }), TypeError);
    assert.throws(() => new InternetData({ apiKey: '   ' }), TypeError);
    assert.throws(() => new InternetData({}), TypeError);
});

test('the key reaches the wire as a bearer token, at the documented host', async () => {
    const c = clientFor({ body: { databases: [] } });

    await c.client.database.list();

    assert.equal(c.calls[0].authorization, `Bearer ${KEY}`);
    assert.equal(c.calls[0].url.origin, DEFAULT_BASE_URL);
    assert.equal(c.calls[0].url.pathname, '/api/v2/database/list');
});

test('baseUrl moves every request', async () => {
    const c = clientFor({ body: { databases: [] } }, { baseUrl: 'https://staging.example.test' });

    await c.client.database.list();

    assert.equal(c.calls[0].url.origin, 'https://staging.example.test');
});

test('metadata is the exporter document, served through unchanged', async () => {
    const c = clientFor({ body: METADATA });

    const meta = await c.client.database.metadata('small_v1');

    assert.deepEqual(meta, METADATA);
    assert.equal(c.calls[0].url.pathname, '/api/v2/database/metadata');
    assert.equal(c.calls[0].url.searchParams.get('id'), 'small_v1');
});

// The unwrap DEPTH, which shipped broken in the VPNDetection Node SDK's 1.0.x:
// `checksums` nests under a key, so reading a top-level sha256 yields undefined.
test('checksums unwraps past the envelope', async () => {
    const c = clientFor({ body: { id: 'small_v1', format: 'csvgz', checksums: CHECKSUMS } });

    const got = await c.client.database.checksums('small_v1', 'csvgz');

    assert.deepEqual(got, CHECKSUMS);
    assert.equal(c.calls[0].url.searchParams.get('format'), 'csvgz');
});

test('downloads unwraps the envelope and passes a limit only when given one', async () => {
    const row = {
        dataset_id: 'small_v1', format: 'csvgz', outcome: 'ok', bytes: 264, http_status: 302,
        apikey_id: 'k', client_ip: '203.0.113.1', user_agent: 'x', created: '2026-09-04T00:00:00Z',
    };
    const c = clientFor({ body: { downloads: [row] } });

    assert.deepEqual(await c.client.database.downloads(), [row]);
    assert.equal(c.calls[0].url.searchParams.get('limit'), null);

    await c.client.database.downloads({ limit: 5 });
    assert.equal(c.calls[1].url.searchParams.get('limit'), '5');
});

test('a 5xx is retried and a success on a later attempt is returned', async () => {
    const c = clientFor(
        [{ status: 503, body: { rc: 'NOT_AVAILABLE' } }, { body: { databases: [] } }],
        { retries: 2 },
    );

    assert.deepEqual(await c.client.database.list(), []);
    assert.equal(c.calls.length, 2);
});

test('a 429 is retried only when it carries Retry-After', async () => {
    const limited = clientFor(
        [{ status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': '0' } },
            { body: { databases: [] } }],
        { retries: 2 },
    );
    assert.deepEqual(await limited.client.database.list(), []);
    assert.equal(limited.calls.length, 2);

    const spent = clientFor({ status: 429, body: { rc: 'QUOTA_EXCEEDED' } }, { retries: 2 });
    await assert.rejects(() => spent.client.database.list(), (err) => {
        assert.equal(err.kind, 'quota_exceeded');
        return true;
    });
    assert.equal(spent.calls.length, 1, 'a spent allowance must not be hammered');
});

test('a transport failure surfaces as a network error', async () => {
    const client = new InternetData({
        apiKey: KEY,
        retries: 0,
        fetch: async () => {
            throw new TypeError('fetch failed');
        },
    });

    await assert.rejects(() => client.database.list(), (err) => {
        assert.ok(err instanceof InternetDataError);
        assert.equal(err.kind, 'network');
        assert.equal(err.retryable, true);
        return true;
    });
});
