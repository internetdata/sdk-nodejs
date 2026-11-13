// The lookups the shared corpus does not reach: batch concurrency, the shared
// request behind the cache, the self-endpoints, the AS and domain lookups, the
// hosts each call goes to, and what each lookup does with an answer it cannot
// read.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { DEFAULT_BASE_URL, InternetData, InternetDataError, isBogon } from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

const IP = '146.70.116.130';
const OTHER = '9.9.9.9';

// A served answer for any address: Unlimited's, as the corpus spells it.
const UNLIMITED = data.lookup.find((c) => c.name === 'unlimited-answer').body;
const served = (ip) => ({ ...UNLIMITED, ip: ip });
const ASN = data.lookup.find((c) => c.name === 'asn-unlimited-answer').body;
const DOMAIN = data.lookup.find((c) => c.name === 'domain-unlimited-answer').body;
const ENTITLEMENT = {
    org_id: '85bb51e4-2eb6-4a31-8e4d-02ba8b98fe61',
    apikey: { id: '0ab424cc-7619-4dad-b027-afacdc2cedb0', expires: null, allowed_cidrs: [] },
    plan: { key: 'max', tier: 'max' },
    usage: {
        requests: 580, quota: 5000000, hard_limit: null,
        window_start: '2026-09-04T07:00:00Z', window_end: '2026-10-04T07:00:00Z',
    },
};

// Answers slowly enough that concurrent calls overlap, and records the peak
// number in flight. Asserting the PEAK is the only way to tell a real limit
// from an option that was accepted and ignored. A batch arrives as one POST per
// chunk, so it is answered from the addresses in the body.
function concurrencyTrackingFetch(delayMs = 20) {
    const state = { inFlight: 0, peak: 0, calls: 0 };
    const fn = async (input, init) => {
        const body = typeof input === 'string' ? (init?.body ?? '') : await input.text();
        state.calls++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        state.inFlight--;
        const results = {};
        for (const ip of JSON.parse(body || '{}').ips ?? []) {
            results[ip] = served(ip);
        }
        return Response.json({ results: results, errors: {} });
    };
    return { fetch: fn, state: state };
}

// Enough addresses for seven chunks of the batch endpoint's 1000, so a
// concurrency bound has something to bound: one request per chunk, and only the
// chunks overlap.
const addrs = Array.from(
    { length: 6001 },
    (_, i) => `9.${1 + Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`,
);

test('isBogon is on the client and agrees with the standalone export', () => {
    const client = new InternetData();
    for (const c of data.isBogon) {
        assert.equal(client.isBogon(c.ip), c.expect, `${c.ip} (${c.why})`);
        assert.equal(client.isBogon(c.ip), isBogon(c.ip), `${c.ip}: client and export disagree`);
    }
});

test('batch concurrency is configurable per call', async () => {
    const t = concurrencyTrackingFetch();
    const client = new InternetData({ fetch: t.fetch, cache: false });

    await client.lookupBatch(addrs, { concurrency: 3 });

    assert.equal(t.state.calls, 7, 'one request per chunk of 1000');
    assert.ok(t.state.peak <= 3, `peak in flight was ${t.state.peak}, expected at most 3`);
    assert.ok(t.state.peak > 1, 'requests should still overlap');
});

test('a per-call concurrency overrides the client default', async () => {
    const t = concurrencyTrackingFetch();
    // Instance default of 2, raised to 6 for this one batch.
    const client = new InternetData({ fetch: t.fetch, cache: false, concurrency: 2 });

    await client.lookupBatch(addrs, { concurrency: 6 });

    assert.ok(t.state.peak > 2, `override ignored: peak was ${t.state.peak}, expected above 2`);
    assert.ok(t.state.peak <= 6, `peak in flight was ${t.state.peak}, expected at most 6`);
});

test('without an override the client concurrency still applies', async () => {
    const t = concurrencyTrackingFetch();
    const client = new InternetData({ fetch: t.fetch, cache: false, concurrency: 2 });

    await client.lookupBatch(addrs);

    assert.ok(t.state.peak <= 2, `peak in flight was ${t.state.peak}, expected at most 2`);
});

// p-limit would throw a bare TypeError for these; they are the caller's mistake.
test('a per-call concurrency below 1 is refused before any request', async () => {
    let calls = 0;
    const client = new InternetData({
        fetch: async () => {
            calls++;
            throw new Error('the network must not be reached');
        },
    });
    for (const concurrency of [0, -1, 0.5, 1.5, NaN]) {
        const call = () => client.lookupBatch([IP, '10.0.0.1'], { concurrency: concurrency });
        await assert.rejects(call, (err) => {
            assert.ok(err instanceof InternetDataError, `${concurrency}: wrong error type`);
            assert.equal(err.kind, 'bad_request', `${concurrency}`);
            assert.equal(err.retryable, false, `${concurrency}`);
            assert.match(err.message, /concurrency/, `${concurrency}`);
            return true;
        });
    }
    assert.equal(calls, 0);
});

test('a client concurrency that is not a whole number from 1 is refused where it is set', () => {
    for (const concurrency of [0, -1, 0.5, 1.5, NaN, 'x', '', '2', {}, [2]]) {
        assert.throws(() => new InternetData({ concurrency: concurrency }), (err) => {
            assert.ok(err instanceof InternetDataError, `${String(concurrency)}: wrong error type`);
            assert.equal(err.kind, 'bad_request', `${String(concurrency)}`);
            assert.match(err.message, /concurrency/, `${String(concurrency)}`);
            return true;
        });
    }
});

test('a null concurrency reads as unset, on the client and per call', async () => {
    const t = concurrencyTrackingFetch();
    const client = new InternetData({ fetch: t.fetch, cache: false, concurrency: null });
    await client.lookupBatch(addrs, { concurrency: null });
    // Seven chunks, all in flight under the default of 8.
    assert.equal(t.state.calls, 7);
    assert.equal(t.state.peak, 7);
});

test('retries are configurable per call', async () => {
    let calls = 0;
    const fetchFn = async () => {
        calls++;
        return Response.json({ error: 'lookup failed' }, { status: 500 });
    };
    const client = new InternetData({ fetch: fetchFn, cache: false, retries: 0 });

    await assert.rejects(() => client.lookup(OTHER, { retries: 2 }));
    // 1 initial attempt plus 2 retries, rather than the instance's 0.
    assert.equal(calls, 3);
});

// Through 2.7.3 p-retry checked the count inside the call, so a bad one failed
// every call as `network` with p-retry's own message. A per-call one is refused
// before a bogon or a cache hit can answer it.
test('a per-call retry count that is not a whole number from 0 is refused where it is set', async () => {
    for (const retries of [-1, 1.5, NaN, -Infinity, '2']) {
        const name = String(retries);
        const c = countingFetch(served(IP));
        const client = new InternetData({ fetch: c.fetch, apiKey: 'k' });
        for (const [call, run] of [
            ['lookup', () => client.lookup(IP, { retries: retries })],
            ['a bogon', () => client.lookup('10.0.0.1', { retries: retries })],
            ['myIp', () => client.myIp({ retries: retries })],
            ['myEntitlement', () => client.myEntitlement({ retries: retries })],
            ['lookupBatch', () => client.lookupBatch(['10.0.0.1'], { retries: retries })],
            ['lookupAsn', () => client.lookupAsn(9009, { retries: retries })],
            ['lookupDomain', () => client.lookupDomain('example.com', { retries: retries })],
        ]) {
            await assert.rejects(run, (err) => err.kind === 'bad_request', `${call}, ${name}`);
        }
        assert.equal(c.state.calls, 0, name);
    }
    for (const retries of [0, 3, Infinity, null]) {
        const c = countingFetch(served(IP));
        const client = new InternetData({ fetch: c.fetch, retries: retries });
        await client.lookup(IP, { retries: retries });
    }
});

// A fetch that answers one fixed body and counts calls.
function countingFetch(body) {
    const state = { calls: 0, urls: [] };
    const fn = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        state.calls++;
        state.urls.push(new URL(url));
        return Response.json(body);
    };
    return { fetch: fn, state: state };
}

test('myIp asks the server which address you are', async () => {
    const t = countingFetch(served('203.0.113.9'));
    const client = new InternetData({ fetch: t.fetch });
    const result = await client.myIp();
    assert.equal(result.ip, '203.0.113.9');
    assert.equal(result.isTor, false);
    assert.equal(t.state.urls[0].pathname, '/myip');
});

// The cache is keyed by address, and which address this is IS the question, so
// a second call has to ask again.
test('myIp is not cached', async () => {
    const t = countingFetch(served('203.0.113.9'));
    const client = new InternetData({ fetch: t.fetch });
    await client.myIp();
    await client.myIp();
    await client.myIp();
    assert.equal(t.state.calls, 3);
});

test('myEntitlement reports the plan and the usage', async () => {
    const t = countingFetch(ENTITLEMENT);
    const client = new InternetData({ fetch: t.fetch, apiKey: 'k' });
    const ent = await client.myEntitlement();
    assert.equal(ent.plan.key, 'max');
    assert.equal(ent.usage.requests, 580);
    // An uncapped plan reports null, which is not zero: zero would read as
    // "stop serving immediately".
    assert.equal(ent.usage.hard_limit, null);
    assert.equal(t.state.urls[0].pathname, '/api/v1/entitlement');
});

// Usage is the whole point, so a cached answer is a wrong one within seconds.
test('myEntitlement is not cached', async () => {
    const t = countingFetch(ENTITLEMENT);
    const client = new InternetData({ fetch: t.fetch, apiKey: 'k' });
    await client.myEntitlement();
    await client.myEntitlement();
    assert.equal(t.state.calls, 2);
});

// The API answers an AS or a domain at the lookup's own path, in a shape the call
// cannot read, so one sent there failed as three retried server errors.
test('lookup refuses what is not an IP address before sending, naming the calls that take it', async () => {
    const t = countingFetch(served(IP));
    const client = new InternetData({ fetch: t.fetch, retries: 2 });
    for (const target of ['AS15169', '15169', 'example.com', '', 'not an address', '1.2.3', '1.2.3.4.5',
        '256.1.1.1', '2001:db8::g', '::ffff:1.2.3.400', 15169, null, undefined]) {
        await assert.rejects(() => client.lookup(target), (err) => {
            assert.ok(err instanceof InternetDataError, `${String(target)}: wrong error type`);
            assert.equal(err.kind, 'bad_request', String(target));
            assert.equal(err.status, undefined, String(target));
            assert.equal(err.message, `'${String(target)}' is not an IP address: `
                + 'look up an AS with lookupAsn, and a domain with lookupDomain', String(target));
            return true;
        });
    }
    assert.equal(t.state.calls, 0, 'a refused target was sent');
    for (const ip of [IP, '2606:4700:4700::1111', '::ffff:146.70.116.130']) {
        await client.lookup(ip);
    }
    assert.deepEqual(t.state.urls.map((u) => u.pathname), [`/${IP}`, '/2606%3A4700%3A4700%3A%3A1111']);
});

// The spec names a production host on each lookup operation, which a generator
// may honor over the client's own base URL. Served from a real local origin, so
// nothing but the base URL can decide where a request goes.
test('every lookup goes to the base URL, never the host the spec names for it', async (t) => {
    const seen = [];
    const server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        const path = req.url;
        const reply = path === '/batch' ? { results: { [OTHER]: served(OTHER) }, errors: {} }
            : path.startsWith('/asn/') ? ASN
                : path.startsWith('/domain/') ? DOMAIN
                    : path === '/api/v1/entitlement' ? ENTITLEMENT : served(IP);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const client = new InternetData({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k' });

    assert.equal((await client.lookup(IP)).ip, IP);
    assert.equal((await client.lookupBatch([OTHER])).get(OTHER).ip, OTHER);
    assert.equal((await client.myIp()).ip, IP);
    assert.equal((await client.lookupAsn(9009)).asn, 9009);
    assert.equal((await client.lookupDomain('example.com')).domain, 'example.com');
    assert.equal((await client.myEntitlement()).plan.key, 'max');
    assert.deepEqual(seen, [
        `GET /${IP}`, 'POST /batch', 'GET /myip', 'GET /asn/9009', 'GET /domain/example.com',
        'GET /api/v1/entitlement',
    ]);
});

// The AS number and the domain go out as given, the domain path-escaped: the API
// normalizes both and refuses what it cannot read.
test('lookupAsn and lookupDomain send what they are given, escaped into the path', async () => {
    const asn = countingFetch(ASN);
    const client = new InternetData({ fetch: asn.fetch });
    const got = await client.lookupAsn(9009);
    assert.equal(got.asn, 9009);
    assert.equal(got.registry, 'ripe');
    assert.equal(asn.state.urls[0].pathname, '/asn/9009');

    const domain = countingFetch(DOMAIN);
    const named = new InternetData({ fetch: domain.fetch });
    assert.equal((await named.lookupDomain('example.com')).isRegistered, true);
    await named.lookupDomain('Bücher.example/x?y#z');
    assert.deepEqual(domain.state.urls.map((u) => u.pathname), [
        '/domain/example.com', '/domain/B%C3%BCcher.example%2Fx%3Fy%23z',
    ]);
    assert.equal(domain.state.urls[1].search, '', 'the domain leaked into the query');
});

test('an AS or domain the API cannot read is its bad_request, sent once', async () => {
    for (const invoke of [(c) => c.lookupAsn(-1), (c) => c.lookupDomain('not a domain')]) {
        let calls = 0;
        const client = new InternetData({
            retries: 2,
            fetch: async () => {
                calls++;
                return Response.json({ error: 'not a valid IP address, AS number or domain' }, { status: 400 });
            },
        });
        await assert.rejects(() => invoke(client), (err) => {
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.message, 'not a valid IP address, AS number or domain');
            return true;
        });
        assert.equal(calls, 1);
    }
});

// Answers after a delay and counts what it was asked, a batch by the addresses in
// its body, so a request shared or sent twice shows in the count.
function sharingFetch(delayMs, refuse = new Set()) {
    const state = { paths: [], batched: [] };
    const fn = async (input, init) => {
        const request = typeof input === 'string' ? new Request(input, init) : input;
        const path = new URL(request.url).pathname;
        state.paths.push(path);
        await new Promise((r) => setTimeout(r, delayMs));
        if (path === '/batch') {
            const ips = JSON.parse(await request.text()).ips;
            state.batched.push(ips);
            const results = {};
            const errors = {};
            for (const ip of ips) {
                if (refuse.has(ip)) {
                    errors[ip] = { status: 403, error: 'forbidden' };
                } else {
                    results[ip] = served(ip);
                }
            }
            return Response.json({ results: results, errors: errors });
        }
        const ip = decodeURIComponent(path.slice(1));
        if (refuse.has(ip)) {
            return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        return Response.json(served(ip));
    };
    return { fetch: fn, state: state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Long enough that a call started a quarter of it later is still concurrent.
const STAGGER = 400;

test('concurrent misses for one address share one request', async () => {
    const t = sharingFetch(200);
    const client = new InternetData({ fetch: t.fetch });

    const answers = await Promise.all(Array.from({ length: 20 }, () => client.lookup(IP)));

    assert.deepEqual(t.state.paths, [`/${IP}`], `20 callers sent ${t.state.paths.length} requests`);
    for (const answer of answers) {
        assert.equal(answer.ip, IP);
    }
});

test('a shared failure reaches every waiter and is not cached', async () => {
    const refuse = new Set([IP]);
    const t = sharingFetch(200, refuse);
    const client = new InternetData({ fetch: t.fetch, retries: 0 });

    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => client.lookup(IP)));

    assert.equal(t.state.paths.length, 1);
    for (const s of settled) {
        assert.equal(s.status, 'rejected');
        assert.equal(s.reason.kind, 'forbidden');
    }
    refuse.clear();
    assert.equal((await client.lookup(IP)).ip, IP);
    assert.equal(t.state.paths.length, 2, 'the failure was cached');
});

test('a batch awaits a lookup in flight', async () => {
    const t = sharingFetch(STAGGER);
    const client = new InternetData({ fetch: t.fetch });

    const single = client.lookup(IP);
    await sleep(STAGGER / 4);
    const batch = await client.lookupBatch([IP, OTHER]);
    await single;

    assert.equal(batch.get(IP).ip, IP);
    assert.equal(batch.get(OTHER).ip, OTHER);
    assert.deepEqual(t.state.batched, [[OTHER]], 'the batch sent the address in flight again');
    assert.equal(t.state.paths.length, 2);
});

test('a lookup awaits a batch in flight', async () => {
    const t = sharingFetch(STAGGER);
    const client = new InternetData({ fetch: t.fetch });

    const batch = client.lookupBatch([IP, OTHER]);
    await sleep(STAGGER / 4);
    const single = await client.lookup(OTHER);
    await batch;

    assert.equal(single.ip, OTHER);
    assert.deepEqual(t.state.paths, ['/batch']);
});

test('a lookup takes the failure of the batch it joined', async () => {
    const t = sharingFetch(STAGGER, new Set([OTHER]));
    const client = new InternetData({ fetch: t.fetch });

    const batch = client.lookupBatch([IP, OTHER]);
    await sleep(STAGGER / 4);
    await assert.rejects(client.lookup(OTHER), (err) => err.kind === 'forbidden');
    const answers = await batch;

    assert.equal(answers.get(OTHER).kind, 'forbidden');
    assert.deepEqual(t.state.paths, ['/batch']);
});

test('a client without a cache shares nothing', async () => {
    const t = sharingFetch(100);
    const client = new InternetData({ fetch: t.fetch, cache: false });

    await Promise.all([
        ...Array.from({ length: 3 }, () => client.lookup(IP)),
        client.lookupBatch([IP]),
        client.lookupBatch([IP]),
    ]);

    assert.equal(t.state.paths.length, 5);
});

// Answers every call the way its path expects and records each URL.
function urlRecordingFetch() {
    const urls = [];
    const fn = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        urls.push(url);
        const path = url.pathname;
        if (path.endsWith('oauth-authorization-server')) {
            return Response.json({ issuer: 'x', authorization_endpoint: 'x', token_endpoint: 'x' });
        }
        if (path.endsWith('/list')) {
            return Response.json({ databases: [] });
        }
        if (path === '/batch') {
            return Response.json({ results: { [OTHER]: served(OTHER) }, errors: {} });
        }
        if (path.startsWith('/asn/')) {
            return Response.json(ASN);
        }
        if (path.startsWith('/domain/')) {
            return Response.json(DOMAIN);
        }
        return Response.json(path === '/api/v1/entitlement' ? ENTITLEMENT : served(IP));
    };
    return { fetch: fn, urls: urls };
}

async function everyCall(client) {
    await client.lookup(IP);
    await client.lookupBatch([OTHER]);
    await client.myIp();
    await client.lookupAsn(9009);
    await client.lookupDomain('example.com');
    await client.myEntitlement();
    await client.database.list();
    await client.oauth.metadata();
}

// Every lookup and database call goes to the API host, and the oauth calls to
// the apex, where the authorization server is.
test('a client without a base URL looks up at the API host and signs in at the apex', async () => {
    const stub = urlRecordingFetch();
    await everyCall(new InternetData({ apiKey: 'k', fetch: stub.fetch }));

    assert.equal(DEFAULT_BASE_URL, 'https://api.internetdata.io');
    assert.deepEqual(stub.urls.map((u) => u.origin), [
        ...Array(7).fill('https://api.internetdata.io'), 'https://internetdata.io',
    ]);
    assert.deepEqual(stub.urls.map((u) => u.pathname), [
        `/${IP}`, '/batch', '/myip', '/asn/9009', '/domain/example.com', '/api/v1/entitlement',
        '/api/v2/database/list', '/.well-known/oauth-authorization-server',
    ]);
});

test('the oauth host is the base URL apex, and any other base URL as given', async () => {
    const cases = [
        ['https://api-staging.internetdata.io', 'https://staging.internetdata.io'],
        ['https://api-staging.internetdata.io//', 'https://staging.internetdata.io'],
        ['https://API.internetdata.io', 'https://internetdata.io'],
        ['https://api.example.test:8443', 'https://example.test:8443'],
        ['http://api-dev.example.test', 'http://dev.example.test'],
        ['https://internetdata.io', 'https://internetdata.io'],
        ['https://staging.internetdata.io', 'https://staging.internetdata.io'],
        ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
        ['https://apis.example.test', 'https://apis.example.test'],
        ['https://proxy.example.test/api.internetdata.io', 'https://proxy.example.test/api.internetdata.io'],
    ];
    for (const [baseUrl, apex] of cases) {
        const stub = urlRecordingFetch();
        const client = new InternetData({ baseUrl: baseUrl, fetch: stub.fetch });
        await client.lookup(IP);
        await client.oauth.metadata();
        const base = baseUrl.replace(/\/+$/, '');
        assert.equal(stub.urls[0].href, new URL(`${base}/${IP}`).href, baseUrl);
        assert.equal(stub.urls[1].href, new URL(`${apex}/.well-known/oauth-authorization-server`).href, baseUrl);
        assert.ok(
            client.oauth.authorizationUrl('c', 'http://127.0.0.1/cb', 'x').startsWith(`${apex}/oauth/authorize?`),
            baseUrl,
        );
    }
});

// A per-call timeout never answers from the cache before it is checked.
test('a per-call timeoutMs bounds an AS and a domain lookup below the client default', async () => {
    for (const invoke of [(c, o) => c.lookupAsn(9009, o), (c, o) => c.lookupDomain('example.com', o)]) {
        const client = new InternetData({ retries: 0, timeoutMs: 10_000, fetch: () => new Promise(() => {}) });
        const started = Date.now();
        await assert.rejects(() => invoke(client, { timeoutMs: 80 }), (err) => {
            assert.equal(err.kind, 'network');
            assert.match(err.message, /timed out after 80ms/);
            return true;
        });
        assert.ok(Date.now() - started < 2000, 'the per-call deadline did not hold');
    }
});

// Per ATTEMPT, like the client-level one: a retried call gets a fresh budget.
test('a per-call timeoutMs applies to each attempt', async () => {
    let calls = 0;
    const client = new InternetData({
        retries: 0,
        timeoutMs: 10_000,
        cache: false,
        fetch: () => {
            calls++;
            return new Promise(() => {});
        },
    });
    await assert.rejects(
        () => client.lookup(IP, { retries: 1, timeoutMs: 80 }),
        (err) => err instanceof InternetDataError && /timed out after 80ms/.test(err.message),
    );
    assert.equal(calls, 2, 'one attempt plus one retry, each abandoned at its own deadline');
});

// p-retry calls onFailedAttempt before it checks retriesLeft, so a 429's
// Retry-After must not be waited out after the last attempt.
test('a lookup Retry-After is not waited out when no retry follows', async () => {
    const fetch = async () => Response.json(
        { error: 'per-minute limit for Unlimited lookups exceeded' },
        { status: 429, headers: { 'retry-after': '3' } },
    );
    // One retry waits the header once, then p-retry's own 1 s backoff.
    for (const [retries, least, most] of [[0, 0, 1000], [1, 3000, 6000]]) {
        const client = new InternetData({ fetch: fetch, cache: false, retries: retries });
        const started = Date.now();
        await assert.rejects(client.lookup(OTHER), (err) => err.kind === 'rate_limited');
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= least && elapsed < most,
            `retries ${retries} failed after ${elapsed} ms, want ${least} to ${most} ms`);
    }
});

function rawClient(reply, options = {}) {
    const calls = [];
    const fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request.url);
        return reply(request);
    };
    return {
        calls: calls,
        client: new InternetData({ apiKey: 'test-key', fetch: fetch, retries: 2, cache: false, ...options }),
    };
}

function body(text, type = 'application/json') {
    return () => new Response(text, { status: 200, headers: { 'content-type': type } });
}

// The body stops part way, as when a proxy drops the connection.
function cutOff() {
    return () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(`{"ip":"${IP}","is_b`));
            controller.error(new TypeError('terminated'));
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const without = (object, member) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== member));

// Each call, a body with its member of the wrong type, and one missing a member it needs.
const CALLS = {
    lookup: [(c) => c.lookup(IP), { ...served(IP), is_tor: 'no' }, without(served(IP), 'is_bogon')],
    myIp: [(c) => c.myIp(), { ...served(IP), ip: 1 }, without(served(IP), 'ip')],
    lookupAsn: [(c) => c.lookupAsn(9009), { ...ASN, asn: '9009' }, without(ASN, 'registry')],
    lookupDomain: [(c) => c.lookupDomain('example.com'), { ...DOMAIN, has_a: 'yes' }, without(DOMAIN, 'has_mx')],
    myEntitlement: [(c) => c.myEntitlement(), { ...ENTITLEMENT, apikey: 'x' }, without(ENTITLEMENT, 'usage')],
};

test('a 2xx a lookup cannot read is a retried server_error carrying its status', async () => {
    for (const [name, [call, wrongType, noMembers]] of Object.entries(CALLS)) {
        const replies = {
            html: body('<html><body>Bad gateway</body></html>', 'text/html'),
            cut: cutOff(),
            empty: body(''),
            null: body('null'),
            array: body('[]'),
            object: body('{}'),
            wrongType: body(JSON.stringify(wrongType)),
            noMembers: body(JSON.stringify(noMembers)),
        };
        // Concurrently, since each sits out the retries' backoff.
        await Promise.all(Object.entries(replies).map(async ([kind, reply]) => {
            const c = rawClient(reply);
            await assert.rejects(() => call(c.client), (err) => {
                assert.equal(err.kind, 'server_error', `${name} ${kind}: ${err.message}`);
                assert.equal(err.status, 200, `${name} ${kind}`);
                return true;
            });
            assert.equal(c.calls.length, 3, `${name} ${kind} is retried`);
        }));
    }
});

test('a batch chunk it cannot read is retried, and fails every address with the status', async () => {
    const replies = {
        html: body('<html><body>Bad gateway</body></html>', 'text/html'),
        cut: cutOff(),
        empty: body(''),
        null: body('null'),
        array: body('[]'),
        object: body('{}'),
        noErrors: body(JSON.stringify({ results: { [IP]: served(IP) } })),
        wrongType: body('{"results":[],"errors":{}}'),
    };
    await Promise.all(Object.entries(replies).map(async ([kind, reply]) => {
        const c = rawClient(reply);
        const out = await c.client.lookupBatch([IP, OTHER]);
        for (const ip of [IP, OTHER]) {
            assert.equal(out.get(ip).kind, 'server_error', `${kind} ${ip}: ${out.get(ip).message}`);
            assert.equal(out.get(ip).status, 200, `${kind} ${ip}`);
        }
        assert.equal(c.calls.length, 3, `${kind} is retried`);
    }));
});

test('one batch entry it cannot read is that address error alone', async () => {
    for (const entry of [{}, [], 'x', { ip: OTHER }, { ...served(OTHER), is_tor: 'no' }]) {
        for (const map of ['results', 'errors']) {
            const answer = { results: { [IP]: served(IP) }, errors: {} };
            answer[map][OTHER] = entry;
            const c = rawClient(body(JSON.stringify(answer)));
            const out = await c.client.lookupBatch([IP, OTHER]);
            const label = `${map} ${JSON.stringify(entry).slice(0, 40)}`;
            assert.equal(out.get(IP).ip, IP, label);
            assert.equal(out.get(OTHER).kind, 'server_error', label);
            assert.equal(out.get(OTHER).status, 200, label);
            assert.equal(c.calls.length, 1, `${label} is not retried for one entry`);
        }
    }
});

test('an address named like a member of every object reads its own entry', async () => {
    const names = ['__proto__', 'constructor', 'toString'];
    const errors = names.map((name) => `"${name}":{"status":400,"error":"not a valid IP address"}`).join(',');
    const c = rawClient(body(`{"results":{"${IP}":${JSON.stringify(served(IP))}},"errors":{${errors}}}`));
    const out = await c.client.lookupBatch([IP, ...names]);
    assert.equal(out.get(IP).ip, IP);
    for (const name of names) {
        assert.equal(out.get(name).kind, 'bad_request', name);
        assert.equal(out.get(name).status, 400, name);
    }
    assert.equal(c.calls.length, 1);
});

// Every shape the corpus serves is readable, and the readable ones come back whole.
test('a readable answer still comes back', async () => {
    for (const c of data.lookup) {
        const call = { lookup: (x) => x.lookup(c.target), lookupAsn: (x) => x.lookupAsn(c.target),
            lookupDomain: (x) => x.lookupDomain(c.target) }[c.call];
        const raw = rawClient(body(JSON.stringify(c.body)));
        assert.deepEqual((await call(raw.client)).raw, c.body, c.name);
        assert.equal(raw.calls.length, 1, c.name);
    }
    // A detail object requires no member: `{}` under a false flag, and whatever it carries.
    const partial = { ...PAID, ip: IP, cdn: { provider: 'cloudflare' }, bittorrent: { verified: true } };
    const detail = rawClient(body(JSON.stringify(partial)));
    assert.deepEqual((await detail.client.lookup(IP)).cdn, { provider: 'cloudflare' });
    const ent = rawClient(body(JSON.stringify(ENTITLEMENT)));
    assert.deepEqual(await ent.client.myEntitlement(), ENTITLEMENT);
    const batch = rawClient(body(JSON.stringify({
        results: { [IP]: served(IP) }, errors: { [OTHER]: { status: 429, error: 'spent' } },
    })));
    const out = await batch.client.lookupBatch([IP, OTHER]);
    assert.deepEqual(out.get(IP).raw, served(IP));
    assert.equal(out.get(OTHER).kind, 'quota_exceeded');
    assert.equal(batch.calls.length, 1);
});

const PAID = data.lookup.find((c) => c.name === 'paid-services').body;
const ASN_PAID = data.lookup.find((c) => c.name === 'asn-paid-answer').body;
const DOMAIN_PAID = data.lookup.find((c) => c.name === 'domain-paid-answer').body;

// A member of the wrong type, at any depth, a numeric string or a null where the
// spec allows none included, is unreadable.
test('a member of the wrong type is a retried server_error carrying its status', async () => {
    const look = (c) => c.lookup(IP);
    const lookup = { ...PAID, ip: IP };
    const asn = (c) => c.lookupAsn(9009);
    const domain = (c) => c.lookupDomain('example.com');
    const ent = (c) => c.myEntitlement();
    const cases = {
        'is_vpn as "yes"': [look, { ...lookup, is_vpn: 'yes' }],
        'is_bogon as null': [look, { ...lookup, is_bogon: null }],
        'a hostname of 1': [look, { ...lookup, hostname: 1 }],
        'a tor detail of "x"': [look, { ...lookup, tor: 'x' }],
        'a cdn provider of 1': [look, { ...lookup, cdn: { ...lookup.cdn, provider: 1 } }],
        'dcproxy hits of "3"': [look, {
            ...lookup, dcproxy: { provider: '', provider_name: '', first_seen: '', last_seen: '', hits: '3',
                hits_days_pct: 1, providers_num: 1 },
        }],
        'a web row with a port of "443"': [look, { ...lookup, web: [{ ...lookup.web[0], port: '443' }] }],
        'web as {}': [look, { ...lookup, web: {} }],
        'web of [null]': [look, { ...lookup, web: [null] }],
        'bittorrent clients of [1]': [look, { ...lookup, bittorrent: { ...lookup.bittorrent, clients: [1] } }],
        'a location latitude of "1"': [look, { ...lookup, location: { ...lookup.location, latitude: '1' } }],
        'a location city of 1': [look, { ...lookup, location: { ...lookup.location, city: 1 } }],
        'a location without its members': [look, { ...lookup, location: {} }],
        'an asn of "5"': [look, { ...lookup, asn: { ...lookup.asn, asn: '5' } }],
        'an asn rpki_status of 1': [look, { ...lookup, asn: { ...lookup.asn, rpki_status: 1 } }],
        'a company type of 1': [look, { ...lookup, company: { ...lookup.company, type: 1 } }],
        'abuse validated as "no"': [look, { ...lookup, abuse: { ...lookup.abuse, validated: 'no' } }],
        'a whois asn of "1"': [look, { ...lookup, whois: { ...lookup.whois, asn: '1' } }],
        'rwhois as {}': [look, { ...lookup, rwhois: {} }],
        'hosted_domains total of 1.5': [look, { ...lookup, hosted_domains: { total: 1.5 } }],
        'trial_expired as 0': [look, { ...lookup, trial_expired: 0 }],
        'myIp with is_web as 0': [(c) => c.myIp(), { ...lookup, is_web: 0 }],
        'num_ips of "1"': [asn, { ...ASN_PAID, num_ips: '1' }],
        'an AS whois value of 1': [asn, { ...ASN_PAID, whois: { ...ASN_PAID.whois, country: 1 } }],
        'a prefix size of "1024"': [asn, { ...ASN_PAID, prefixes: [{ ...ASN_PAID.prefixes[0], size: '1024' }] }],
        'other_origins of ["1"]': [asn, {
            ...ASN_PAID, prefixes: [{ ...ASN_PAID.prefixes[0], other_origins: ['1'] }],
        }],
        'is_registered as "yes"': [domain, { ...DOMAIN_PAID, is_registered: 'yes' }],
        'an mx priority of "10"': [domain, {
            ...DOMAIN_PAID, dns: { ...DOMAIN_PAID.dns, mx: [{ ...DOMAIN_PAID.dns.mx[0], priority: '10' }] },
        }],
        'dns without cname': [domain, { ...DOMAIN_PAID, dns: without(DOMAIN_PAID.dns, 'cname') }],
        'ip_ranges ipv4 of "256"': [domain, {
            ...DOMAIN_PAID, ip_ranges: { ...DOMAIN_PAID.ip_ranges, ipv4: '256' },
        }],
        'disposable providers of [1]': [domain, {
            ...DOMAIN_PAID, disposable: { confidence: 'high', providers: [1], first_seen: '', last_seen: '' },
        }],
        'requests of "5"': [ent, { ...ENTITLEMENT, usage: { ...ENTITLEMENT.usage, requests: '5' } }],
        'a hard_limit of "5"': [ent, { ...ENTITLEMENT, usage: { ...ENTITLEMENT.usage, hard_limit: '5' } }],
        'a tier of 1': [ent, { ...ENTITLEMENT, plan: { key: 'max', tier: 1 } }],
        'allowed_cidrs of [1]': [ent, { ...ENTITLEMENT, apikey: { ...ENTITLEMENT.apikey, allowed_cidrs: [1] } }],
        'a window_end of "tomorrow"': [ent, {
            ...ENTITLEMENT, usage: { ...ENTITLEMENT.usage, window_end: 'tomorrow' },
        }],
    };
    // Concurrently, since each sits out the retries' backoff.
    await Promise.all(Object.entries(cases).map(async ([name, [call, answer]]) => {
        const c = rawClient(body(JSON.stringify(answer)));
        await assert.rejects(() => call(c.client), (err) => {
            assert.equal(err.kind, 'server_error', `${name}: ${err.message}`);
            assert.equal(err.status, 200, name);
            return true;
        });
        assert.equal(c.calls.length, 3, `${name} is retried`);
    }));
    // A batch entry it cannot read is that address's error alone, unretried.
    const c = rawClient(body(JSON.stringify({ results: { [IP]: { ...lookup, is_vpn: 'yes' } }, errors: {} })));
    const out = await c.client.lookupBatch([IP]);
    assert.equal(out.get(IP).kind, 'server_error');
    assert.equal(c.calls.length, 1);
});

const shapes = await import('../dist/shapes.js');
const GENERATED = readFileSync(new URL('../src/generated/types.gen.ts', import.meta.url), 'utf8');

function block(name) {
    return GENERATED.split(`export type ${name} = {\n`)[1].split('\n};')[0];
}

// The lists are hand-written, so a member the spec makes required, and never null,
// must not be able to go unchecked: read the generated types and compare.
test('each checked lookup member list is every required member of its generated type', () => {
    const required = (name) => [...block(name).matchAll(/^ {4}([a-z][a-z0-9_]*): (.*)$/gm)]
        .filter((m) => !/\| null;$/.test(m[2])).map((m) => m[1]).sort();
    const lists = {
        LookupResponse: shapes.LOOKUP_MEMBERS, WebDetail: shapes.WEB_DETAIL_MEMBERS,
        Location: shapes.LOCATION_MEMBERS,
        Asn: shapes.ASN_MEMBERS, Company: shapes.COMPANY_MEMBERS, AbuseContact: shapes.ABUSE_CONTACT_MEMBERS,
        Whois: shapes.WHOIS_MEMBERS, Rwhois: shapes.RWHOIS_MEMBERS, HostedDomains: shapes.HOSTED_DOMAINS_MEMBERS,
        AsnLookupResponse: shapes.ASN_LOOKUP_MEMBERS, AsnPrefix: shapes.ASN_PREFIX_MEMBERS,
        DomainLookupResponse: shapes.DOMAIN_LOOKUP_MEMBERS, DomainDns: shapes.DOMAIN_DNS_MEMBERS,
        DnsAddressRecord: shapes.DNS_ADDRESS_RECORD_MEMBERS, DnsMxRecord: shapes.DNS_MX_RECORD_MEMBERS,
        DnsNsRecord: shapes.DNS_NS_RECORD_MEMBERS, DnsCnameRecord: shapes.DNS_CNAME_RECORD_MEMBERS,
        DomainIpRanges: shapes.DOMAIN_IP_RANGES_MEMBERS, DomainIpRange: shapes.DOMAIN_IP_RANGE_MEMBERS,
        BatchLookupResponse: shapes.BATCH_MEMBERS,
        BatchLookupError: shapes.BATCH_ERROR_MEMBERS, Entitlement: shapes.ENTITLEMENT_MEMBERS,
        EntitlementApikey: shapes.ENTITLEMENT_APIKEY_MEMBERS, EntitlementPlan: shapes.ENTITLEMENT_PLAN_MEMBERS,
        EntitlementUsage: shapes.ENTITLEMENT_USAGE_MEMBERS,
    };
    for (const [name, list] of Object.entries(lists)) {
        assert.deepEqual([...list].sort(), required(name), name);
    }
    // A detail object requires nothing, which is what lets `{}` stand under a false flag.
    for (const name of ['ClassDetail', 'ProxyDetail', 'PubproxyDetail', 'CarrierDetail', 'SatelliteDetail',
        'SshDetail', 'SmtpDetail', 'DnsResolverDetail', 'BitTorrentDetail', 'DisposableDetail']) {
        assert.deepEqual(required(name), [], name);
    }
});

// Each type table names every member of its generated type, optional and nullable
// ones included, so a member the spec adds is typed before it can come back unread.
test('each lookup type table covers every member of its generated type', () => {
    const members = (name) => [...block(name).matchAll(/^ {4}([a-z][a-z0-9_]*)\??: /gm)].map((m) => m[1]).sort();
    const tables = {
        LookupResponse: shapes.LOOKUP_TYPES, ClassDetail: shapes.CLASS_DETAIL_TYPES,
        ProxyDetail: shapes.PROXY_DETAIL_TYPES, PubproxyDetail: shapes.PUBPROXY_DETAIL_TYPES,
        CarrierDetail: shapes.CARRIER_DETAIL_TYPES, SatelliteDetail: shapes.SATELLITE_DETAIL_TYPES,
        SshDetail: shapes.SSH_DETAIL_TYPES, SmtpDetail: shapes.SMTP_DETAIL_TYPES,
        WebDetail: shapes.WEB_DETAIL_TYPES,
        DnsResolverDetail: shapes.DNS_RESOLVER_DETAIL_TYPES, BitTorrentDetail: shapes.BITTORRENT_DETAIL_TYPES,
        Location: shapes.LOCATION_TYPES, Asn: shapes.ASN_TYPES, Company: shapes.COMPANY_TYPES,
        AbuseContact: shapes.ABUSE_CONTACT_TYPES, Whois: shapes.WHOIS_TYPES, Rwhois: shapes.RWHOIS_TYPES,
        HostedDomains: shapes.HOSTED_DOMAINS_TYPES, AsnLookupResponse: shapes.ASN_LOOKUP_TYPES,
        AsnPrefix: shapes.ASN_PREFIX_TYPES, DomainLookupResponse: shapes.DOMAIN_LOOKUP_TYPES,
        DomainDns: shapes.DOMAIN_DNS_TYPES, DnsAddressRecord: shapes.DNS_ADDRESS_RECORD_TYPES,
        DnsMxRecord: shapes.DNS_MX_RECORD_TYPES, DnsNsRecord: shapes.DNS_NS_RECORD_TYPES,
        DnsCnameRecord: shapes.DNS_CNAME_RECORD_TYPES, DomainIpRanges: shapes.DOMAIN_IP_RANGES_TYPES,
        DomainIpRange: shapes.DOMAIN_IP_RANGE_TYPES, DisposableDetail: shapes.DISPOSABLE_DETAIL_TYPES,
        BatchLookupError: shapes.BATCH_ERROR_TYPES, Entitlement: shapes.ENTITLEMENT_TYPES,
        EntitlementApikey: shapes.ENTITLEMENT_APIKEY_TYPES, EntitlementPlan: shapes.ENTITLEMENT_PLAN_TYPES,
        EntitlementUsage: shapes.ENTITLEMENT_USAGE_TYPES,
    };
    for (const [name, table] of Object.entries(tables)) {
        assert.deepEqual(Object.keys(table).sort(), members(name), name);
    }
    // Each wire member the client maps has a type, and `number` only where the spec says so.
    for (const [name, table] of Object.entries(tables)) {
        for (const [member, kind] of Object.entries(table)) {
            if (kind === 'number' || kind === 'integer') {
                const declared = new RegExp(`^ {4}${member}\\??: (.*);$`, 'm').exec(block(name))?.[1];
                assert.match(declared ?? '', /^number( \| null)?$/, `${name}.${member}`);
            }
        }
    }
});
