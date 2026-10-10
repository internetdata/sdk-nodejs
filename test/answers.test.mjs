// What each database call does with a 2xx it cannot read as its answer: a retried
// server_error carrying the status, never undefined, a page of HTML or a raw
// TypeError handed back. Through 2.5.1 `list` answered undefined for `{}`,
// `metadata` answered the HTML itself, and a cut-off or `null` body failed once
// as a network error with no status.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { InternetData } from '../dist/index.js';
import {
    DATABASE_MEMBERS, DATABASE_METADATA_MEMBERS, DATABASE_VERSION_MEMBERS, DB_CHECKSUMS_MEMBERS, DOWNLOAD_MEMBERS,
} from '../dist/shapes.js';

function rawClient(reply) {
    const calls = [];
    const fetch = async (input) => {
        calls.push(typeof input === 'string' ? input : input.url);
        return reply();
    };
    return { calls: calls, client: new InternetData({ apiKey: 'test-key', fetch: fetch, retries: 2 }) };
}

function body(text, type = 'application/json') {
    return () => new Response(text, { status: 200, headers: { 'content-type': type } });
}

// The body stops part way, as when a proxy drops the connection.
function cutOff() {
    return () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"databases":[{"base":'));
            controller.error(new TypeError('terminated'));
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const CALLS = {
    list: [(c) => c.database.list(), '{"databases":"x"}', '{"databases":[{}]}'],
    metadata: [(c) => c.database.metadata('bogon_asn'), '{"id":1,"updated":"","entries":"x","schema":{},"size":{}}', '{"id":"bogon_asn"}'],
    checksums: [(c) => c.database.checksums('bogon_asn', 'csvgz'), '{"checksums":"x"}', '{"checksums":{}}'],
    downloads: [(c) => c.database.downloads(), '{"downloads":"x"}', '{"downloads":[{}]}'],
};

test('a 2xx a database call cannot read is a retried server_error carrying its status', async () => {
    for (const [name, [call, wrongType, noMembers]] of Object.entries(CALLS)) {
        const replies = {
            html: body('<html><body>Bad gateway</body></html>', 'text/html'),
            cut: cutOff(),
            empty: body(''),
            null: body('null'),
            array: body('[]'),
            object: body('{}'),
            wrongType: body(wrongType),
            noMembers: body(noMembers),
        };
        for (const [kind, reply] of Object.entries(replies)) {
            const c = rawClient(reply);
            await assert.rejects(() => call(c.client), (err) => {
                assert.equal(err.kind, 'server_error', `${name} ${kind}: ${err.message}`);
                assert.equal(err.status, 200, `${name} ${kind}`);
                return true;
            });
            assert.equal(c.calls.length, 3, `${name} ${kind} is retried`);
        }
    }
});

test('a readable answer still comes back', async () => {
    const version = { id: 'bogon_asn_v1', version: 1, summary: 's', formats: ['csvgz'] };
    const database = {
        base: 'bogon_asn', name: 'n', summary: 's', standing: 'licensed', open: false, license_type: null,
        starts: null, expires: null, versions: [version],
    };
    const c = rawClient(body(JSON.stringify({ databases: [database] })));
    assert.deepEqual(await c.client.database.list(), [database]);
    assert.equal(c.calls.length, 1);
});

// The lists are hand-written, so a member the spec makes required, and never null,
// must not be able to go unchecked: read the generated types and compare.
test('each checked member list is every required member of its generated type', () => {
    const types = readFileSync(new URL('../src/generated/types.gen.ts', import.meta.url), 'utf8');
    const required = (name) => {
        const block = types.split(`export type ${name} = {\n`)[1].split('\n};')[0];
        return [...block.matchAll(/^ {4}([a-z][a-z0-9_]*): (.*)$/gm)]
            .filter((m) => !/\| null;$/.test(m[2])).map((m) => m[1]).sort();
    };
    assert.deepEqual([...DATABASE_MEMBERS].sort(), required('Database'));
    assert.deepEqual([...DATABASE_VERSION_MEMBERS].sort(), required('DatabaseVersion'));
    assert.deepEqual([...DATABASE_METADATA_MEMBERS].sort(), required('DatabaseMetadata'));
    assert.deepEqual([...DB_CHECKSUMS_MEMBERS].sort(), required('DbChecksums'));
    assert.deepEqual([...DOWNLOAD_MEMBERS].sort(), required('Download'));
});
