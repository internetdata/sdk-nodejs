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
    for (const options of [{}, { apiKey: undefined }, { apiKey: '' }, { apiKey: '   ' }, { apiKey: '\t' }, { apiKey: ' \n' }]) {
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
        dataset_id: 'small_v1', format: 'csvgz', outcome: 'ok', sample: false, open: true, bytes: 264,
        http_status: 302, apikey_id: 'k', client_ip: '203.0.113.1', user_agent: 'x',
        created: '2026-09-04T00:00:00Z',
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

test('a key is sent without the blanks around it', async () => {
    const c = clientFor({ body: { databases: [] } }, { apiKey: ` ${KEY}\n` });

    await c.client.database.list();

    assert.equal(c.calls[0].authorization, `Bearer ${KEY}`);
});

// fetch refuses a header holding one, so through 2.5.1 every call failed as a
// retried network error with nothing sent; a CRLF would otherwise start a header.
test('a key holding a control character is refused where it is set', () => {
    for (const apiKey of ['k\x01ey', 'key\r\nX-Injected: 1', 'k\u007fey', 42]) {
        assert.throws(() => new InternetData({ apiKey: apiKey }), (err) => {
            assert.ok(err instanceof InternetDataError);
            assert.equal(err.kind, 'bad_request');
            return true;
        }, JSON.stringify(apiKey));
    }
});

// Digits, or one of RFC 9110's three date forms in GMT, and nothing else: through
// 2.5.1 `Number` and `Date.parse` read `+1`, `0x10`, `1e3`, `1.5`, ISO dates, other
// zones and 31 November as throttles, and asctime as local time.
test('a Retry-After is seconds or an HTTP date and nothing else', async () => {
    const at = (offset) => new Date(Date.now() + offset);
    const day = (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
    const forms = {
        imf: (d) => d.toUTCString(),
        rfc850: (d) => {
            const [, dd, mon, yyyy, time] = d.toUTCString().split(' ');
            return `${day(d)}, ${dd}-${mon}-${yyyy.slice(2)} ${time} GMT`;
        },
        asctime: (d) => {
            const [wkd, , mon, yyyy, time] = d.toUTCString().split(' ');
            return `${wkd.slice(0, 3)} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${time} ${yyyy}`;
        },
    };
    for (const [form, format] of Object.entries(forms)) {
        // Computed when its case runs: a date fixed up front can pass before it is served.
        const c = clientFor({ status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': format(at(10_000)) } });
        await assert.rejects(() => c.client.database.list(), (err) => {
            assert.equal(err.kind, 'rate_limited', form);
            assert.ok(err.retryAfterSeconds >= 8 && err.retryAfterSeconds <= 11, `${form}: ${err.retryAfterSeconds}`);
            return true;
        });
    }
    for (const value of ['7', '0']) {
        const c = clientFor({ status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': value } });
        await assert.rejects(() => c.client.database.list(), (err) => {
            assert.equal(err.kind, 'rate_limited', value);
            assert.equal(err.retryAfterSeconds, Number(value));
            return true;
        });
    }
    const spent = [
        '+1', '-1', 'x', 'tomorrow', '1e400', '0x10', '0b11', '1_0', '1e3', '1.5', '2099-01-01',
        '2099-01-01T00:00:00', 'Jan 1 2099', 'Sun, 31 Nov 2099 08:49:37 GMT', 'Fri, 01 Jan 2099 00:00:00 PST',
        'Fri, 01 Jan 2099 00:00:00 +0500', 'Fri, 01 Jan 2099 24:00:00 GMT', 'Xyz, 01 Jan 2099 00:00:00 GMT',
    ];
    for (const value of spent) {
        const c = clientFor({ status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': value } }, { retries: 2 });
        await assert.rejects(() => c.client.database.list(), (err) => {
            assert.equal(err.kind, 'quota_exceeded', value);
            return true;
        });
        assert.equal(c.calls.length, 1, value);
    }
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

test('a Retry-After is not waited out when no retry is left', async () => {
    const limited = clientFor(
        { status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': '3' } },
        { retries: 0 },
    );
    const started = Date.now();
    await assert.rejects(() => limited.client.database.list(), (err) => {
        assert.equal(err.kind, 'rate_limited');
        assert.equal(err.retryAfterSeconds, 3);
        return true;
    });
    assert.equal(limited.calls.length, 1);
    assert.ok(Date.now() - started < 1000, `failed after ${Date.now() - started} ms`);
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

// Answers every call the way its path expects and records the paths, so a
// doubled slash shows up as a path rather than as whatever a server makes of it.
function pathRecordingFetch() {
    const paths = [];
    const fn = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path.endsWith('/download')) {
            return new Response(null, { status: 302, headers: { location: 'https://s3.invalid/f' } });
        }
        const body = path.endsWith('oauth-authorization-server')
            ? { issuer: 'x', authorization_endpoint: 'x', token_endpoint: 'x' }
            : { databases: [] };
        return new Response(JSON.stringify(body), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    return { fetch: fn, paths: paths };
}

// Every path the client appends starts with a slash. One trailing slash on the
// base URL was dropped, but through 2.3.0 a second doubled into every path
// (//api/v2/database/list), which the API answers with a redirect.
test('every trailing slash on the base URL is dropped', async (t) => {
    for (const suffix of ['/', '//', '///']) {
        await t.test(JSON.stringify(suffix), async () => {
            const stub = pathRecordingFetch();
            const client = new InternetData({
                baseUrl: `https://api.example.test${suffix}`, apiKey: KEY, fetch: stub.fetch, retries: 0,
            });
            await client.database.list();
            await client.database.downloadUrl('small_v1', 'csvgz');
            await client.oauth.metadata();
            await client.oauth.revoke('internetdata-cli', 'mo_rt_x');
            assert.deepEqual(stub.paths, [
                '/api/v2/database/list', '/api/v2/database/download',
                '/.well-known/oauth-authorization-server', '/oauth/revoke',
            ]);
        });
    }
});

// setTimeout runs 0, a negative, NaN, Infinity and anything past 2^31 - 1 ms as
// 1 ms, so through 2.3.0 each failed every call as a timeout 1 ms in, retried.
// Refused where set instead, and per call before the poll's first wait.
const IMPOSSIBLE_TIMEOUTS = [0, -1, NaN, Infinity, 2 ** 31, '5000'];

test('a timeout no attempt can meet is refused on the client', () => {
    for (const timeoutMs of IMPOSSIBLE_TIMEOUTS) {
        assert.throws(() => new InternetData({ timeoutMs: timeoutMs }),
            (err) => err instanceof InternetDataError && err.kind === 'bad_request', String(timeoutMs));
    }
    for (const timeoutMs of [1, 2 ** 31 - 1]) {
        assert.doesNotThrow(() => new InternetData({ timeoutMs: timeoutMs }), String(timeoutMs));
    }
});

test('a timeout no attempt can meet is refused per call, before any request', async () => {
    const stub = pathRecordingFetch();
    const client = new InternetData({ apiKey: KEY, fetch: stub.fetch, retries: 0 });
    const calls = {
        'downloads': (o) => client.database.downloads(o),
        'metadata': (o) => client.oauth.metadata(o),
        'deviceAuthorization': (o) => client.oauth.deviceAuthorization('internetdata-cli', o),
        'exchangeDeviceCode': (o) => client.oauth.exchangeDeviceCode('internetdata-cli', 'mo_dc_x', o),
        'exchangeRefreshToken': (o) => client.oauth.exchangeRefreshToken('internetdata-cli', 'mo_rt_x', o),
        'revoke': (o) => client.oauth.revoke('internetdata-cli', 'mo_rt_x', o),
        'pollDeviceToken': (o) => client.oauth.pollDeviceToken('internetdata-cli', {
            device_code: 'mo_dc_x', user_code: 'x', verification_uri: 'x', expires_in: 900, interval: 2,
        }, o),
    };
    // Before its first wait, not after sitting out the interval.
    const started = performance.now();
    await assert.rejects(calls.pollDeviceToken({ timeoutMs: 0 }), InternetDataError);
    assert.ok(performance.now() - started < 1000, 'the poll waited before refusing');
    for (const timeoutMs of IMPOSSIBLE_TIMEOUTS) {
        for (const [name, call] of Object.entries(calls)) {
            await assert.rejects(call({ timeoutMs: timeoutMs }),
                (err) => err instanceof InternetDataError && err.kind === 'bad_request', `${name}: ${timeoutMs}`);
        }
    }
    assert.equal(stub.paths.length, 0, 'a refused timeout sent a request');
});

// setTimeout runs a delay past 2^31 - 1 ms as 1 ms and prints a
// TimeoutOverflowWarning, which through 2.3.0 is how a Retry-After of 2147484 s
// or more was waited: on the caller's stderr. The backoff alone waits it now.
test('a Retry-After past what setTimeout holds waits the backoff, with no warning', async (t) => {
    const warnings = timeoutWarnings(t);
    const limited = clientFor(
        [{ status: 429, body: { rc: 'RATE_LIMITED' }, headers: { 'retry-after': '2147484' } },
            { body: { databases: [] } }],
        { retries: 1 },
    );

    assert.deepEqual(await limited.client.database.list(), []);
    assert.equal(limited.calls.length, 2);
    assert.deepEqual(warnings, []);
});

function timeoutWarnings(t) {
    const seen = [];
    const listener = (warning) => {
        if (warning.name === 'TimeoutOverflowWarning') {
            seen.push(warning.message);
        }
    };
    process.on('warning', listener);
    t.after(() => process.off('warning', listener));
    return seen;
}
