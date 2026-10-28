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
    CHECKSUM_ANSWER_MEMBERS, DATABASE_MEMBERS, DATABASE_METADATA_MEMBERS, DATABASE_VERSION_MEMBERS,
    DB_CHECKSUMS_MEMBERS, DOWNLOAD_MEMBERS,
} from '../dist/shapes.js';

function rawClient(reply, retries = 2) {
    const calls = [];
    const fetch = async (input) => {
        calls.push(typeof input === 'string' ? input : input.url);
        return reply();
    };
    return { calls: calls, client: new InternetData({ apiKey: 'test-key', fetch: fetch, retries: retries }) };
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

// Through 2.5.4 only presence was checked, so a version served as "3" came back
// as that string, and every member below came back as served.
test('a member of the wrong type is a retried server_error carrying its status', async () => {
    const version = { id: 'bogon_asn_v1', version: 1, summary: 's', formats: ['csvgz'] };
    const database = {
        base: 'bogon_asn', name: 'n', summary: 's', standing: 'licensed', open: false, license_type: null,
        starts: null, expires: null, versions: [version],
    };
    const metadata = {
        id: 'bogon_asn_v1', updated: '2026-09-04', entries: 1,
        schema: { csvgz: [{ name: 'ip', type: 'string' }] }, size: { csvgz: 760 },
    };
    const download = {
        dataset_id: 'bogon_asn_v1', format: 'csvgz', outcome: 'ok', sample: false, open: false, bytes: 760,
        http_status: 302, apikey_id: null, client_ip: null, user_agent: null, created: '2026-09-04T10:00:00Z',
    };
    const list = (c) => c.database.list();
    const meta = (c) => c.database.metadata('bogon_asn_v1');
    const cases = {
        'a version of "3"': [list, { databases: [{ ...database, versions: [{ ...version, version: '3' }] }] }],
        'a version of 1.5': [list, { databases: [{ ...database, versions: [{ ...version, version: 1.5 }] }] }],
        'a format of 1': [list, { databases: [{ ...database, versions: [{ ...version, formats: [1] }] }] }],
        'a base of 7': [list, { databases: [{ ...database, base: 7 }] }],
        'open as "false"': [list, { databases: [{ ...database, open: 'false' }] }],
        'a license_type of 1': [list, { databases: [{ ...database, license_type: 1 }] }],
        'entries of "1"': [meta, { ...metadata, entries: '1' }],
        'a size of "760"': [meta, { ...metadata, size: { csvgz: '760' } }],
        'a column name of 1': [meta, { ...metadata, schema: { csvgz: [{ name: 1, type: 'string' }] } }],
        // Through 2.7.1 nothing inside `sample` was read, so these came back as served.
        'a null sample row': [meta, { ...metadata, sample: { csvgz: [null] } }],
        'a sample row of "x"': [meta, { ...metadata, sample: { csvgz: ['x'] } }],
        'sample rows of {}': [meta, { ...metadata, sample: { csvgz: {} } }],
        'an md5 of 7': [(c) => c.database.checksums('bogon_asn_v1', 'csvgz'),
            { checksums: { md5: 7, sha1: 's', sha256: 's', sha512: 's' } }],
        'bytes of "760"': [(c) => c.database.downloads(), { downloads: [{ ...download, bytes: '760' }] }],
        // Unchecked through 2.7.3, so it came back as served.
        'a client_ip of 5': [(c) => c.database.downloads(), { downloads: [{ ...download, client_ip: 5 }] }],
    };
    for (const [name, [call, answer]] of Object.entries(cases)) {
        const c = rawClient(body(JSON.stringify(answer)));
        await assert.rejects(() => call(c.client), (err) => {
            assert.equal(err.kind, 'server_error', `${name}: ${err.message}`);
            assert.equal(err.status, 200, name);
            return true;
        });
        assert.equal(c.calls.length, 3, `${name} is retried`);
    }
});

// `checksums` hands back the digests alone, so through 2.7.3 nothing read `id` or
// `format`, and an answer without either, or with one null or of another type, came back.
test('a checksum answer without its id or format is a retried server_error', async () => {
    const answer = {
        id: 'bogon_asn_v1', format: 'csvgz', checksums: { md5: 'a', sha1: 'b', sha256: 'c', sha512: 'd' },
    };
    const cases = {
        'no id': { ...answer, id: undefined },
        'an id of null': { ...answer, id: null },
        'an id of 7': { ...answer, id: 7 },
        'no format': { ...answer, format: undefined },
        'a format of null': { ...answer, format: null },
        'a format of 7': { ...answer, format: 7 },
    };
    for (const [name, served] of Object.entries(cases)) {
        const c = rawClient(body(JSON.stringify(served)));
        await assert.rejects(() => c.client.database.checksums('bogon_asn_v1', 'csvgz'), (err) => {
            assert.equal(err.kind, 'server_error', `${name}: ${err.message}`);
            assert.equal(err.status, 200, name);
            return true;
        });
        assert.equal(c.calls.length, 3, `${name} is retried`);
    }
    const c = rawClient(body(JSON.stringify(answer)));
    assert.deepEqual(await c.client.database.checksums('bogon_asn_v1', 'csvgz'), answer.checksums);
});

// RFC 3339 alone, on a day that exists. Through 2.7.4 a date was checked as a
// string alone, so every one of these came back as served (measured 2026-10-28).
test('a date or date-time that is not RFC 3339 is a retried server_error', async () => {
    const dateTimes = ['2026-10-05', '2026-10-05T10:00:00', '2026-10-05T10:00:00+05', '2026-10-05T10:00Z',
        '2026-10-05T10:00:00+0500', '2026-10-05T10:00:00+05:00:30', '2026-10-05T24:00:00Z', '2026-10-05T10:60:00Z',
        '2026-10-05T10:00:60Z', '2026-02-30T10:00:00Z', '2026-10-05T10:00:00+24:00', '2026-10-05T10:00:00+05:60',
        ' 2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z ', '2026-10-05 10:00:00Z', '2026-10-5T10:00:00Z',
        '+12026-10-05T10:00:00Z', '2026-10-05T10:00:00.Z', '20261005T100000Z', '2026-10-05T10:00:00UTC', 'x',
        'tomorrow', 'monday', ''];
    const dates = ['2026-10-05T10:00:00', '2026-10-05T10:00:00Z', '2026-02-30', '2026-11-31', '2026-13-01', '2026-10-5',
        '20261005', '2026-W41-1', '2026-278', ' 2026-10-05', '+12026-10-05', 'x', 'tomorrow', 'monday', ''];
    const database = {
        base: 'bogon_asn', name: 'n', summary: 's', standing: 'licensed', open: false, license_type: null,
        starts: null, expires: null, renews_at: null, notice_due_at: null,
        versions: [{ id: 'bogon_asn_v1', version: 1, summary: 's', formats: ['csvgz'] }],
    };
    const metadata = {
        id: 'bogon_asn_v1', updated: '2026-09-04', entries: 1,
        schema: { csvgz: [{ name: 'ip', type: 'string' }] }, size: { csvgz: 760 },
    };
    const download = {
        dataset_id: 'bogon_asn_v1', format: 'csvgz', outcome: 'ok', sample: false, open: false, bytes: 760,
        http_status: 302, apikey_id: null, client_ip: null, user_agent: null, created: '2026-09-04T10:00:00Z',
    };
    const list = (c) => c.database.list();
    const cases = [];
    for (const value of dateTimes) {
        for (const member of ['starts', 'expires', 'renews_at', 'notice_due_at']) {
            cases.push([`${member} ${value}`, list, { databases: [{ ...database, [member]: value }] }]);
        }
        cases.push([`created ${value}`, (c) => c.database.downloads(), { downloads: [{ ...download, created: value }] }]);
    }
    for (const value of dates) {
        cases.push([`updated ${value}`, (c) => c.database.metadata('bogon_asn_v1'), { ...metadata, updated: value }]);
    }
    // Each case once with no retries, since each retry waits out the backoff, and the
    // first of each member's again with them, to show it is retried.
    const retried = new Set();
    for (const [name, call, served] of cases) {
        const member = name.split(' ')[0];
        const retries = retried.has(member) ? 0 : 1;
        retried.add(member);
        const c = rawClient(body(JSON.stringify(served)), retries);
        await assert.rejects(() => call(c.client), (err) => {
            assert.equal(err.kind, 'server_error', `${name}: ${err.message}`);
            assert.equal(err.status, 200, name);
            return true;
        });
        assert.equal(c.calls.length, retries + 1, `${name} is sent ${retries + 1} times`);
    }
    for (const value of ['2026-10-05T10:00:00Z', '2026-10-05t10:00:00.5z', '2026-10-05T10:00:00-00:00',
        '2026-10-05T10:00:00.123456789+05:30', '2024-02-29T23:59:59+23:59', '0001-01-01T00:00:00Z']) {
        const c = rawClient(body(JSON.stringify({ databases: [{ ...database, starts: value }] })));
        assert.equal((await c.client.database.list())[0].starts, value, value);
    }
    for (const value of ['2026-10-05', '2024-02-29', '0099-12-31']) {
        const c = rawClient(body(JSON.stringify({ ...metadata, updated: value })));
        assert.equal((await c.client.database.metadata('bogon_asn_v1')).updated, value, value);
    }
});

// Each `date` and `date-time` kind is the spec's `format` for that member, and no
// other member carries one, so a date the spec adds is checked before it ships.
test('each date kind is the format the spec names', async () => {
    const shapes = await import('../dist/shapes.js');
    const spec = readFileSync(new URL('../spec/openapi.yaml', import.meta.url), 'utf8');
    const formats = new Map();
    let schema = null;
    let member = null;
    for (const line of spec.split('\n').slice(spec.split('\n').indexOf('components:'))) {
        schema = /^ {4}([A-Za-z][A-Za-z0-9]*):$/.exec(line)?.[1] ?? schema;
        member = /^ {8}([a-z_]+):$/.exec(line)?.[1] ?? member;
        const format = /^ {10}format: (date|date-time)$/.exec(line)?.[1];
        if (format !== undefined) {
            formats.set(`${schema}.${member}`, format);
        }
    }
    const tables = {
        Database: shapes.DATABASE_TYPES, DatabaseVersion: shapes.DATABASE_VERSION_TYPES,
        DatabaseMetadata: shapes.DATABASE_METADATA_TYPES, DatabaseMetadataColumn: shapes.COLUMN_TYPES,
        Download: shapes.DOWNLOAD_TYPES,
    };
    const kinds = new Map();
    for (const [name, table] of Object.entries(tables)) {
        for (const [m, kind] of Object.entries(table)) {
            if (kind === 'date' || kind === 'date-time') {
                kinds.set(`${name}.${m}`, kind);
            }
        }
    }
    for (const [at, format] of formats) {
        if (tables[at.split('.')[0]] !== undefined) {
            assert.equal(kinds.get(at), format, at);
        }
    }
    const covered = [...formats.keys()].filter((at) => tables[at.split('.')[0]] !== undefined);
    assert.equal(kinds.size, covered.length);
    assert.equal(kinds.size, 6);
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
    const answer = types.split('export type DatabaseChecksumV2Responses = {\n')[1].split('\n    };')[0];
    const members = [...answer.matchAll(/^ {8}([a-z][a-z0-9_]*): (.*)$/gm)].map((m) => m[1]).sort();
    assert.deepEqual([...CHECKSUM_ANSWER_MEMBERS].sort(), members);
});
