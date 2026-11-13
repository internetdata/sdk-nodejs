// Asserts the shared conformance corpus that every InternetData SDK asserts.
//
// The corpus is generated into testdata/ and is identical across languages, so
// a behavior that drifts here fails here rather than surfacing as two client
// libraries quietly disagreeing about the same refusal.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    DATABASE_FORMATS, InternetData, InternetDataError, LICENSE_TYPES, STANDINGS, isBogon,
} from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

const KEY = 'test-key';

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// A served answer for any address: Unlimited's, as the corpus spells it.
const UNLIMITED = data.lookup.find((c) => c.name === 'unlimited-answer').body;
const served = (ip) => ({ ...UNLIMITED, ip: ip });

// A lookup stand-in that answers from a table and counts what it was asked for,
// so "never touched the network" is asserted rather than assumed.
function routedFetch(routes) {
    const calls = [];
    const fn = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push(url);
        if (new URL(url).pathname === '/batch') {
            return batchResponse(routes, await bodyOf(input, init));
        }
        const ip = decodeURIComponent(new URL(url).pathname.slice(1));
        const r = routes[ip];
        if (r === undefined) {
            return new Response(JSON.stringify({ error: 'not a valid IP address, AS number or domain' }), {
                status: 400, headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(r.body), {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        });
    };
    return { fetch: fn, calls: calls };
}

// The request body, whichever way the client handed it to fetch: as a Request
// object, or as an init alongside a URL string.
async function bodyOf(input, init) {
    if (typeof input !== 'string' && typeof input.text === 'function') {
        return input.text();
    }
    return typeof init?.body === 'string' ? init.body : '';
}

// A POST /batch is answered the way the API answers one: every address the
// table knows is a result if its route is a 200 and an entry error otherwise,
// and an unknown address is the 400 the API gives a string that is not one.
function batchResponse(routes, body) {
    const results = {};
    const errors = {};
    for (const ip of JSON.parse(body || '{}').ips ?? []) {
        const r = routes[ip];
        if (r === undefined) {
            errors[ip] = { status: 400, error: 'not a valid IP address, AS number or domain' };
        } else if ((r.status ?? 200) === 200) {
            results[ip] = r.body;
        } else {
            errors[ip] = { status: r.status, error: r.body.error };
        }
    }
    return new Response(JSON.stringify({ results: results, errors: errors }), {
        status: 200, headers: { 'content-type': 'application/json' },
    });
}

// A fetch stand-in answering one canned response, recording every request so a
// test can assert what did NOT happen as well as what did.
function stubFetch(reply) {
    const calls = [];
    const fn = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const headers = input?.headers ?? new Headers(init?.headers ?? {});
        calls.push({ url: url, authorization: headers.get('authorization') });
        const r = typeof reply === 'function' ? reply(calls.length) : reply;
        return new Response(JSON.stringify(r.body), {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        });
    };
    return { fetch: fn, calls: calls };
}

function client(reply, options = {}) {
    const stub = stubFetch(reply);
    return {
        calls: stub.calls,
        client: new InternetData({ apiKey: KEY, fetch: stub.fetch, retries: 0, ...options }),
    };
}

// Every case on a lookup and on a database call alike: the lookups answer an
// `error` member and the database calls an `rc`, and the message is either.
test('every refusal maps to the kind the corpus pins', async () => {
    const calls = {
        'lookup': (c) => c.lookup('146.70.116.130'),
        'database.list': (c) => c.database.list(),
    };
    for (const [call, invoke] of Object.entries(calls)) {
        for (const c of data.errors) {
            const c8n = client({ status: c.status, body: c.body, headers: c.headers });
            await assert.rejects(
                () => invoke(c8n.client),
                (err) => {
                    assert.ok(err instanceof InternetDataError, `${call} ${c.name}: wrong error type`);
                    assert.equal(err.kind, c.expect.kind, `${call} ${c.name}`);
                    assert.equal(err.retryable, c.expect.retryable, `${call} ${c.name}: retryable`);
                    assert.equal(err.status, c.status, `${call} ${c.name}: status`);
                    if (c.expect.message !== undefined) {
                        assert.equal(err.message, c.expect.message, `${call} ${c.name}: message`);
                    }
                    if (c.expect.retryAfterSeconds !== undefined) {
                        assert.equal(err.retryAfterSeconds, c.expect.retryAfterSeconds, `${call} ${c.name}`);
                    }
                    return true;
                },
            );
            assert.equal(c8n.calls.length, 1, `${call} ${c.name}: one attempt, retries disabled`);
        }
    }
});

// Retries on, so a classifier that marks one of these retryable sends more than
// one request.
test('a refusal the corpus pins as not retryable is sent once, with retries on', async () => {
    for (const c of data.errors.filter((e) => !e.expect.retryable)) {
        const c8n = client({ status: c.status, body: c.body, headers: c.headers }, { retries: 2 });
        await assert.rejects(() => c8n.client.lookup('146.70.116.130'), (err) => err.kind === c.expect.kind);
        assert.equal(c8n.calls.length, 1, `${c.name}: sent again`);
    }
});

test('isBogon matches the canonical ranges', () => {
    for (const c of data.isBogon) {
        assert.equal(isBogon(c.ip), c.expect, `${c.ip} (${c.why})`);
    }
});

// A server listening on :: sees every IPv4 visitor as ::ffff:a.b.c.d, which read
// whole is inside ::ffff:0:0/96, so it would be answered as a bogon with no
// request made.
test('an IPv4-mapped address is judged, sent and cached as the IPv4 address it carries', async () => {
    for (const c of data.ipv4Mapped) {
        assert.equal(isBogon(c.ip), c.expect, `${c.ip} (${c.why})`);
        const routes = { [c.carries]: { body: served(c.carries) } };

        const stub = routedFetch(routes);
        const client = new InternetData({ fetch: stub.fetch });
        const r = await client.lookup(c.ip);
        assert.equal(r.isBogon, c.expect, c.ip);
        assert.equal(r.ip, c.carries, c.ip);
        await client.lookup(c.carries);
        assert.deepEqual(stub.calls.map((u) => new URL(u).pathname), c.expect ? [] : [`/${c.carries}`], c.ip);

        const sent = [];
        const batchStub = routedFetch(routes);
        const recording = async (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            if (new URL(url).pathname === '/batch') {
                sent.push(...JSON.parse(await bodyOf(typeof input === 'string' ? input : input.clone(), init)).ips);
            }
            return batchStub.fetch(input, init);
        };
        const uncached = new InternetData({ fetch: recording, cache: false });
        const asked = [...new Set([c.ip, c.carries])];
        const batch = await uncached.lookupBatch(asked);
        assert.deepEqual([...batch.keys()], asked, c.ip);
        assert.equal(batch.get(c.ip).ip, c.carries, c.ip);
        assert.deepEqual(sent, c.expect ? [] : [c.carries], c.ip);
    }
});

// The API's own answer for a bogon, on a paid plan, with the address filled in.
test('a bogon is answered locally in the full paid shape', async () => {
    const stub = routedFetch({});
    const c = new InternetData({ fetch: stub.fetch });
    const want = data.bogonResponse;

    for (const ip of ['10.0.0.1', 'fe80::1']) {
        const r = await c.lookup(ip);

        assert.deepEqual(r.raw, { ...want.answer, ip: ip }, ip);
        assert.equal(r.ip, ip);
        assert.equal(r.isBogon, true);
        for (const f of want.flagsFalse) {
            assert.equal(r[camel(f)], false, `${f} must be present and false`);
        }
        for (const o of want.emptyObjects) {
            assert.deepEqual(r[camel(o)], {}, `${o} must be present and empty`);
        }
        for (const l of want.emptyLists) {
            assert.deepEqual(r[camel(l)], [], `${l} must be present and empty`);
        }
        for (const o of ['location', 'asn', 'company', 'abuse', 'whois', 'rwhois']) {
            assert.deepEqual(r[o], want[o], `${o} must carry every key, empty`);
        }
        assert.equal(r.hostname, want.hostname);
        assert.deepEqual(r.hostedDomains, want.hostedDomains);
    }
    assert.equal(stub.calls.length, 0, 'a bogon must not reach the network');
});

// Absent is "not in your plan", never false or zero, at the top level and inside
// a shared object alike; an empty detail object is present.
test('a lookup keeps absent apart from false across every plan shape', async () => {
    const calls = {
        lookup: [(c, target) => c.lookup(target), (target) => `/${target}`],
        lookupAsn: [(c, target) => c.lookupAsn(target), (target) => `/asn/${target}`],
        lookupDomain: [(c, target) => c.lookupDomain(target), (target) => `/domain/${target}`],
    };
    for (const c of data.lookup) {
        const [invoke, path] = calls[c.call];
        assert.ok(invoke !== undefined, `the corpus adds ${c.call} and this suite does not drive it`);
        const stub = stubFetch({ status: c.status, body: c.body });
        const client = new InternetData({ fetch: stub.fetch });
        const r = await invoke(client, c.target);

        assert.equal(new URL(stub.calls[0].url).pathname, path(c.target), c.name);
        assert.deepEqual(r.raw, c.body, `${c.name}: raw is the wire answer`);
        for (const [k, v] of Object.entries(c.expect.present)) {
            assert.equal(r[camel(k)], v, `${c.name}: ${k} should be ${v}`);
        }
        for (const k of c.expect.objects) {
            assert.equal(typeof r[camel(k)], 'object', `${c.name}: ${k} must be present`);
            assert.notEqual(r[camel(k)], null, `${c.name}: ${k} must be present`);
        }
        for (const k of c.expect.empty) {
            const empty = Array.isArray(c.body[k]) ? [] : {};
            assert.deepEqual(r[camel(k)], empty, `${c.name}: ${k} must be present and empty`);
        }
        for (const k of c.expect.absent) {
            assert.ok(!(camel(k) in r), `${c.name}: ${k} must be ABSENT, not false or zero`);
        }
        for (const [o, members] of Object.entries(c.expect.absentIn ?? {})) {
            for (const k of members) {
                assert.ok(!(k in r[camel(o)]), `${c.name}: ${o}.${k} must be ABSENT, not empty or zero`);
            }
        }
    }
});

test('batch dedupes, short-circuits bogons and keys by address', async () => {
    const c = data.batch.find((b) => b.name === 'dedup-bogon-and-order-free-keying');
    const stub = routedFetch({ '1.1.1.1': { body: served('1.1.1.1') }, '8.8.8.8': { body: served('8.8.8.8') } });
    const client = new InternetData({ fetch: stub.fetch });
    const got = await client.lookupBatch(c.input);

    assert.deepEqual([...got.keys()], c.expect.keys);
    assert.equal(stub.calls.length, c.expect.httpRequests);
    for (const k of c.expect.bogonKeys) {
        assert.equal(got.get(k).isBogon, true, `${k} should be a local answer`);
    }
});

test('one bad address does not lose the rest of the batch', async () => {
    const c = data.batch.find((b) => b.name === 'partial-failure-does-not-fail-the-batch');
    const stub = routedFetch({ '1.1.1.1': { body: served('1.1.1.1') } });
    const client = new InternetData({ fetch: stub.fetch, retries: 0 });
    const got = await client.lookupBatch(c.input);

    assert.deepEqual([...got.keys()], c.expect.keys);
    for (const k of c.expect.errorKeys) {
        assert.ok(got.get(k) instanceof InternetDataError, `${k} should carry its error`);
        assert.equal(got.get(k).kind, c.expect.errorKinds[k], `${k} should be ${c.expect.errorKinds[k]}`);
    }
    assert.equal(got.get('1.1.1.1').isTor, false, 'the good address still answered');
});

test('a cache hit issues no second request', async () => {
    const c = data.batch.find((b) => b.name === 'cache-hit-issues-no-second-request');
    const stub = routedFetch({ '1.1.1.1': { body: served('1.1.1.1') } });
    const client = new InternetData({ fetch: stub.fetch });

    for (let i = 0; i < c.repeat; i++) {
        await client.lookupBatch(c.input);
    }
    assert.equal(stub.calls.length, c.expect.httpRequests);
});

// One POST /batch per chunk of 1000, and no cap on what a caller passes.
test('a large batch is sent in chunks of a thousand, whatever its size', async (t) => {
    for (const name of ['chunks-of-one-thousand', 'uncapped-input-is-chunked']) {
        await t.test(name, async () => {
            const c = data.batch.find((b) => b.name === name);
            const posts = [];
            const fetchFn = async (input) => {
                const sent = JSON.parse(await input.text()).ips;
                posts.push({ method: input.method, path: new URL(input.url).pathname, ips: sent });
                const results = Object.fromEntries(sent.map((ip) => [ip, served(ip)]));
                return new Response(JSON.stringify({ results: results, errors: {} }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            };
            const client = new InternetData({ fetch: fetchFn, cache: false });
            const got = await client.lookupBatch(c.input);

            assert.equal(posts.length, c.expect.httpRequests, 'one request per chunk');
            for (const post of posts) {
                assert.equal(`${post.method} ${post.path}`, 'POST /batch');
                assert.ok(post.ips.length <= 1000, `a chunk carried ${post.ips.length} addresses`);
            }
            const sent = posts.flatMap((p) => p.ips);
            assert.deepEqual(sent.sort(), [...c.input].sort(), 'each address sent once');
            assert.equal(got.size, c.expect.keyCount);
            for (const ip of c.input) {
                assert.equal(got.get(ip).ip, ip, `${ip} should be answered for itself`);
            }
        });
    }
});

// A per-entry failure carries no headers, so its 429 can only be a spent
// allowance, and a 500 is the server's; neither is retried per entry, because
// retries belong to the call and the call succeeded.
test('an entry error is classified by its status', async () => {
    const c = data.batch.find((b) => b.name === 'an-entry-error-is-classified-by-its-status');
    const stub = routedFetch({
        '1.1.1.1': { body: served('1.1.1.1') },
        '8.8.8.8': { status: 429, body: { error: 'overage cap reached; raise or remove it in Billing' } },
        '9.9.9.9': { status: 500, body: { error: 'lookup failed' } },
    });
    const client = new InternetData({ fetch: stub.fetch, retries: 3 });
    const got = await client.lookupBatch(c.input);

    assert.deepEqual([...got.keys()], c.expect.keys);
    for (const [ip, kind] of Object.entries(c.expect.errorKinds)) {
        assert.ok(got.get(ip) instanceof InternetDataError, `${ip} should carry its error`);
        assert.equal(got.get(ip).kind, kind, `${ip} should be ${kind}`);
    }
    assert.equal(stub.calls.length, c.expect.httpRequests);
});

test('two clients never share a cached answer', async () => {
    const stub = routedFetch({ '1.1.1.1': { body: served('1.1.1.1') } });
    const a = new InternetData({ fetch: stub.fetch, apiKey: 'key-a' });
    const b = new InternetData({ fetch: stub.fetch, apiKey: 'key-b' });

    await a.lookup('1.1.1.1');
    await b.lookup('1.1.1.1');
    // Two keys can be on different plans and so entitled to different fields;
    // a shared cache would serve one of them the other's shape.
    assert.equal(stub.calls.length, 2);
});

test('caching can be turned off', async () => {
    const stub = routedFetch({ '1.1.1.1': { body: served('1.1.1.1') } });
    const client = new InternetData({ fetch: stub.fetch, cache: false });
    await client.lookup('1.1.1.1');
    await client.lookup('1.1.1.1');
    assert.equal(stub.calls.length, 2);
});

// The AS and domain lookups are served every time: nothing about them is cached.
test('an AS or domain lookup is never cached', async () => {
    for (const [name, invoke] of [
        ['asn-unlimited-answer', (c) => c.lookupAsn(9009)],
        ['domain-unlimited-answer', (c) => c.lookupDomain('example.com')],
    ]) {
        const stub = stubFetch({ body: data.lookup.find((c) => c.name === name).body });
        const client = new InternetData({ fetch: stub.fetch });
        await invoke(client);
        await invoke(client);
        assert.equal(stub.calls.length, 2, name);
    }
});

// A 4xx that is not 400/401/403/429 is the case three of four VPNDetection SDKs
// got wrong by mapping an enumerated list and letting the rest fall through to a
// retryable server_error default.
test('a non-enumerated 4xx is never retried', async () => {
    const notFound = data.errors.filter((c) => c.status === 404);
    assert.ok(notFound.length > 0, 'the corpus no longer pins a 404');

    for (const c of notFound) {
        const c8n = client({ status: c.status, body: c.body }, { retries: 3 });
        await assert.rejects(() => c8n.client.database.metadata('no_such_database_v1'));
        assert.equal(c8n.calls.length, 1, `${c.name}: a 404 must not be retried`);
    }
});

test('the closed vocabularies match the corpus exactly', () => {
    assert.deepEqual([...DATABASE_FORMATS].sort(), [...data.formats].sort());
    assert.deepEqual([...STANDINGS].sort(), [...data.standings].sort());
    assert.deepEqual([...LICENSE_TYPES].sort(), [...data.license_type].sort());
});

// The generated union guards a TypeScript caller and nobody else, so a format
// from a CLI flag or a JS caller has to be refused from the RUNTIME list, before
// it costs a request. Every download method goes through the same check.
test('an unpublished format is refused locally and costs no request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'internetdata-format-'));
    try {
        for (const format of ['zip', 'MMDB', 'csv.gz', '', undefined]) {
            const c8n = client({ body: {} });
            const calls = {
                checksums: () => c8n.client.database.checksums('small_v1', format),
                downloadUrl: () => c8n.client.database.downloadUrl('small_v1', format),
                download: () => c8n.client.database.download('small_v1', format, join(dir, 'f')),
                downloadBytes: () => c8n.client.database.downloadBytes('small_v1', format),
            };
            for (const [method, call] of Object.entries(calls)) {
                await assert.rejects(call, (err) => {
                    assert.ok(err instanceof InternetDataError, `${method}(${format}): wrong error type`);
                    assert.equal(err.kind, 'bad_request', `${method}(${format})`);
                    assert.equal(err.retryable, false, `${method}(${format})`);
                    assert.equal(err.status, undefined, `${method}(${format}) answered without a response`);
                    for (const allowed of DATABASE_FORMATS) {
                        assert.ok(err.message.includes(allowed), `${method} must name ${allowed}`);
                    }
                    return true;
                });
            }
            assert.equal(c8n.calls.length, 0, `${JSON.stringify(format)} reached the network`);
        }
        assert.deepEqual(readdirSync(dir), [], 'a refused download must not touch the destination');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// The other half, so a check that refused EVERYTHING cannot pass: each published
// format goes out as asked.
test('every published format reaches the network', async () => {
    for (const format of DATABASE_FORMATS) {
        const c8n = client({
            body: { id: 'small_v1', format: format, checksums: { md5: 'a', sha1: 'b', sha256: 'c', sha512: 'd' } },
        });
        await c8n.client.database.checksums('small_v1', format);
        assert.equal(c8n.calls.length, 1, format);
        assert.equal(new URL(c8n.calls[0].url).searchParams.get('format'), format);
    }
});

// One handler per rule in the corpus, and the corpus decides which rules exist:
// a rule added there turns this suite red until it is implemented, rather than
// being quietly absent from one language.
const VISIBILITY_RULES = {
    'listing-is-returned-as-served': async () => {
        const served = {
            databases: [
                {
                    base: 'public_one', name: 'Public One', summary: 'a', standing: 'licensed',
                    open: false, license_type: 'standard', starts: null, expires: null,
                    versions: [{ id: 'public_one_v1', version: 1, summary: 'a', formats: ['csvgz'] }],
                },
                {
                    base: 'public_two', name: 'Public Two', summary: 'b', standing: 'unlicensed',
                    open: true, license_type: null, starts: null, expires: null,
                    versions: [{ id: 'public_two_v1', version: 1, summary: 'b', formats: ['mmdb'] }],
                },
            ],
        };
        const c8n = client({ body: served });

        assert.deepEqual(await c8n.client.database.list(), served.databases);
    },
    'no-catalog-is-compiled-into-the-client': () => {
        // The shape of every database ID and family name. A client that shipped
        // its own copy of the catalog, or defaulted to one, would show up here;
        // a listing is the server's answer for THIS key and nothing else can
        // stand in for it.
        const ID = /\b[a-z][a-z0-9_]*_(ip|asn|provider)(_v[0-9]+)?\b/g;
        // Wire members, and no database: the download log's caller address, and
        // whether a BitTorrent peer's node ID matches its address.
        const MEMBERS = ['client_ip', 'id_matches_ip'];
        const dist = new URL('../dist/', import.meta.url);
        for (const name of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
            const hits = (readFileSync(join(dist.pathname, name), 'utf8').match(ID) ?? [])
                .filter((hit) => !MEMBERS.includes(hit));
            assert.deepEqual(hits, [], `${name} names ${hits.join(', ')}`);
        }
    },
    'a-listing-is-never-reused-across-clients': async () => {
        const body = { databases: [] };
        const shared = stubFetch({ body: body });
        const a = new InternetData({ apiKey: 'key-a', fetch: shared.fetch });
        const b = new InternetData({ apiKey: 'key-b', fetch: shared.fetch });

        await a.database.list();
        await b.database.list();
        await a.database.list();

        assert.equal(shared.calls.length, 3, 'a listing was reused rather than asked for');
        assert.deepEqual(
            shared.calls.map((c) => c.authorization),
            ['Bearer key-a', 'Bearer key-b', 'Bearer key-a'],
        );
    },
};

test('the visibility contract holds', async (t) => {
    const rules = data.visibility.clientRules;
    assert.ok(Array.isArray(rules) && rules.length > 0, 'the corpus pins no visibility rules');

    for (const rule of rules) {
        const check = VISIBILITY_RULES[rule];
        assert.ok(check !== undefined, `the corpus adds ${rule} and this suite does not check it`);
        await t.test(rule, check);
    }
});
