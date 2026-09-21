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

// The key is optional because what the API serves without a license is a product
// decision, and a client that cannot be built without one would have to break
// its own signature to follow it. What must never happen is `Authorization:
// Bearer ` with nothing after it, which reads as a wrong key rather than none.
test('a client builds with no key and sends no authorization header', async () => {
    for (const options of [{}, { apiKey: undefined }, { apiKey: '' }]) {
        const s = stub({ body: { databases: [] } });
        const client = new InternetData({ fetch: s.fetch, retries: 0, ...options });

        await client.database.list();

        assert.equal(s.calls[0].authorization, null, `apiKey: ${JSON.stringify(options.apiKey)}`);
    }
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

test('a hung API is abandoned at the deadline, not held until undici gives up', async () => {
    const client = new InternetData({ retries: 0, timeoutMs: 80, fetch: () => new Promise(() => {}) });
    const started = Date.now();
    await assert.rejects(
        () => client.database.list(),
        (err) => err instanceof InternetDataError && err.kind === 'network' && err.retryable
            && /timed out after 80ms/.test(err.message),
    );
    assert.ok(Date.now() - started < 2000, 'the deadline did not hold');
});

// Two ways a response stalls: nothing arrives, or the headers do and the body
// never finishes. The deadline has to bound the whole call, not just the first.
const STALLS = {
    'no response': () => new Promise(() => {}),
    'a body that never ends': async () => new Response(new ReadableStream({ start() {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
    }),
};

// Every call that takes per-call options, each surfacing its failure as a
// rejection.
const PER_CALL = {
    'database.downloads': (c, o) => c.database.downloads({ limit: 5, ...o }),
    'oauth.metadata': (c, o) => c.oauth.metadata(o),
    'oauth.deviceAuthorization': (c, o) => c.oauth.deviceAuthorization('your-client-id', o),
    'oauth.exchangeDeviceCode': (c, o) => c.oauth.exchangeDeviceCode('your-client-id', 'mo_dc_x', o),
    'oauth.exchangeRefreshToken': (c, o) => c.oauth.exchangeRefreshToken('your-client-id', 'mo_rt_x', o),
    'oauth.revoke': (c, o) => c.oauth.revoke('your-client-id', 'mo_rt_x', o),
    // Waits nothing, and parks rather than spinning if the poll never ends.
    'oauth.pollDeviceToken': (c, o) => {
        let waits = 0;
        c.oauth.clock = {
            now: () => 0,
            sleep: () => (++waits > 16 ? new Promise(() => {}) : Promise.resolve()),
        };
        const device = {
            device_code: 'mo_dc_x', user_code: 'x', verification_uri: 'x', expires_in: 900, interval: 5,
        };
        return c.oauth.pollDeviceToken('your-client-id', device, o);
    },
};

// Set BELOW the client's, so the only deadline that can fire in time is the
// per-call one, and its message names which one it was.
test('a per-call timeoutMs bounds every call below the client default', async () => {
    for (const [stallName, stall] of Object.entries(STALLS)) {
        for (const [call, invoke] of Object.entries(PER_CALL)) {
            const client = new InternetData({ retries: 0, timeoutMs: 10_000, fetch: stall });
            const label = `${call}, ${stallName}`;
            const started = Date.now();
            await assert.rejects(() => invoke(client, { timeoutMs: 80 }), (err) => {
                assert.ok(err instanceof InternetDataError, `${label}: wrong error type`);
                assert.equal(err.kind, 'network', label);
                assert.equal(err.retryable, true, label);
                assert.match(err.message, /timed out after 80ms/, label);
                return true;
            });
            assert.ok(Date.now() - started < 2000, `${label}: the per-call deadline did not hold`);
        }
    }
});

// Per ATTEMPT, like the client-level one: a retried call gets a fresh budget.
test('a per-call timeoutMs applies to each attempt', async () => {
    let calls = 0;
    const client = new InternetData({
        retries: 1,
        timeoutMs: 10_000,
        fetch: () => {
            calls++;
            return new Promise(() => {});
        },
    });
    await assert.rejects(
        () => client.database.downloads({ timeoutMs: 80 }),
        (err) => err instanceof InternetDataError && /timed out after 80ms/.test(err.message),
    );
    assert.equal(calls, 2, 'one attempt plus one retry, each abandoned at its own deadline');
});

test('a per-call timeoutMs never reaches the wire', async () => {
    const c = clientFor({ body: { downloads: [] } });

    await c.client.database.downloads({ limit: 5, timeoutMs: 5000 });

    assert.deepEqual([...c.calls[0].url.searchParams.keys()], ['limit']);
});

test('a dataset transfer is exempt from the deadline', async () => {
    // Serves the 302 slowly enough to blow a tiny budget, then a body that
    // arrives after it. Only the API leg is bounded, so the transfer completes.
    const client = new InternetData({
        retries: 0,
        timeoutMs: 5000,
        fetch: async (input) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.includes('/download')) {
                return new Response(null, { status: 302, headers: { location: 'https://s3.invalid/f' } });
            }
            await new Promise((r) => setTimeout(r, 60));
            return new Response('payload', { status: 200 });
        },
    });
    const url = await client.database.downloadUrl('any_v1', 'csvgz');
    assert.equal(url, 'https://s3.invalid/f');
    assert.equal((await client.database.downloadBytes('any_v1', 'csvgz')).length, 7);
});

// The spec documents three credential forms because the API accepts three, and
// the generator will happily apply all of them - putting the key in the query
// string of every request. A query string is the one place a secret must not
// be: access logs, proxy logs and browser history all keep it, and none of
// those are ours. Asserted on what leaves the client, because the request
// succeeds either way.
test('the key is sent in the Authorization header and nowhere else', async () => {
    let seen = null;
    const fetchFn = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const headers = new Headers(input?.headers ?? init?.headers ?? {});
        seen = {
            query: url.searchParams.get('apikey'),
            authorization: headers.get('authorization'),
            xApiKey: headers.get('x-api-key'),
        };
        return new Response(JSON.stringify({ databases: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    await new InternetData({ fetch: fetchFn, apiKey: 'SECRET' }).database.list();

    assert.equal(seen.authorization, 'Bearer SECRET');
    assert.equal(seen.query, null, 'the key must never reach a URL');
    assert.equal(seen.xApiKey, null, 'one credential form, not three');
});
