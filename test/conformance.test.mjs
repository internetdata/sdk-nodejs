// Asserts the shared conformance corpus that every InternetData SDK asserts.
//
// The corpus is generated into testdata/ and is identical across languages, so
// a behaviour that drifts here fails here rather than surfacing as two client
// libraries quietly disagreeing about the same refusal.
//
// Runs against dist/, which is what actually ships.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    DATASET_FORMATS, InternetData, InternetDataError, REDISTRIBUTION_RIGHTS, STANDINGS,
} from '../dist/index.js';

const data = JSON.parse(readFileSync(new URL('../testdata/testdata.json', import.meta.url), 'utf8'));

const KEY = 'test-key';

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

test('every refusal maps to the kind the corpus pins', async () => {
    for (const c of data.errors) {
        const c8n = client({ status: c.status, body: c.body, headers: c.headers });
        await assert.rejects(
            () => c8n.client.database.list(),
            (err) => {
                assert.ok(err instanceof InternetDataError, `${c.name}: wrong error type`);
                assert.equal(err.kind, c.expect.kind, c.name);
                assert.equal(err.retryable, c.expect.retryable, `${c.name}: retryable`);
                assert.equal(err.status, c.status, `${c.name}: status`);
                if (c.expect.message !== undefined) {
                    assert.equal(err.message, c.expect.message, `${c.name}: message`);
                }
                if (c.expect.retryAfterSeconds !== undefined) {
                    assert.equal(err.retryAfterSeconds, c.expect.retryAfterSeconds, c.name);
                }
                return true;
            },
        );
        assert.equal(c8n.calls.length, 1, `${c.name}: one attempt, retries disabled`);
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
    assert.deepEqual([...DATASET_FORMATS].sort(), [...data.formats].sort());
    assert.deepEqual([...STANDINGS].sort(), [...data.standings].sort());
    assert.deepEqual([...REDISTRIBUTION_RIGHTS].sort(), [...data.redistribution].sort());
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
                    redistribution: 'internal', starts: null, expires: null,
                    versions: [{ id: 'public_one_v1', version: 1, summary: 'a', formats: ['csvgz'] }],
                },
                {
                    base: 'public_two', name: 'Public Two', summary: 'b', standing: 'unlicensed',
                    redistribution: null, starts: null, expires: null,
                    versions: [{ id: 'public_two_v1', version: 1, summary: 'b', formats: ['mmdb'] }],
                },
            ],
        };
        const c8n = client({ body: served });

        assert.deepEqual(await c8n.client.database.list(), served.databases);
    },
    'no-catalog-is-compiled-into-the-client': () => {
        // The shape of every database id and family name. A client that shipped
        // its own copy of the catalog, or defaulted to one, would show up here;
        // a listing is the server's answer for THIS key and nothing else can
        // stand in for it.
        const ID = /\b[a-z][a-z0-9_]*_(ip|asn|provider)(_v[0-9]+)?\b/g;
        const dist = new URL('../dist/', import.meta.url);
        for (const name of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
            const hits = readFileSync(join(dist.pathname, name), 'utf8').match(ID);
            assert.equal(hits, null, `${name} names ${hits?.join(', ')}`);
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
