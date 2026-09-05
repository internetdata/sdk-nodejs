// The whole surface, against the real staging API and real object storage.
//
// Everything is derived from `list()`: which family to move, which one to be
// refused for. A hardcoded id turns a licence change into a red build that says
// nothing about the client, and the size ceiling in staging.mjs is what makes
// deriving it safe.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
    DATASET_FORMATS, InternetDataError, REDISTRIBUTION_RIGHTS, STANDINGS,
} from '@internetdata/internetdata';

import { skipForNoKey } from '../lib/key.mjs';
import {
    databases, requestLog, smallestLicensedFile, stagingClient, STAGING_ORIGIN, unlicensedFile,
} from '../lib/staging.mjs';

const NO_KEY = skipForNoKey();

const tmp = mkdtempSync(join(tmpdir(), 'internetdata-integration-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let transfer = null;

test('the catalog answers the schema the client was generated from', { skip: NO_KEY }, async () => {
    const listed = await databases();

    assert.ok(listed.length > 0, 'the staging catalog is empty');
    for (const db of listed) {
        assert.equal(typeof db.base, 'string', 'a family carries no base');
        assert.equal(typeof db.name, 'string', `${db.base} carries no name`);
        assert.equal(typeof db.summary, 'string', `${db.base} carries no summary`);
        assert.ok(STANDINGS.includes(db.standing), `${db.base} carries standing ${db.standing}`);
        assert.ok(
            db.redistribution === null || REDISTRIBUTION_RIGHTS.includes(db.redistribution),
            `${db.base} carries redistribution ${db.redistribution}`,
        );
        assert.ok(Array.isArray(db.versions) && db.versions.length > 0,
            `${db.base} carries no versions`);
        for (const v of db.versions) {
            assert.equal(typeof v.id, 'string', `${db.base} has a version with no id`);
            assert.equal(typeof v.version, 'number', `${v.id} carries no version number`);
            assert.ok(Array.isArray(v.formats) && v.formats.length > 0, `${v.id} is built in nothing`);
            for (const f of v.formats) {
                assert.ok(DATASET_FORMATS.includes(f), `${v.id} is built in undocumented ${f}`);
            }
        }
    }
    console.log(`catalog: ${listed.map((d) => `${d.base}:${d.standing}`).join(', ')}`);

    // Without this the run is indistinguishable from one whose key never
    // reached the wire, and every comparison above is vacuous - an empty key is
    // sent as no auth header at all, though the client now refuses to be built
    // from one.
    const toApi = requestLog().filter((f) => f.origin === STAGING_ORIGIN);
    assert.ok(toApi.length > 0, 'no request reached the staging API');
    assert.ok(toApi.every((f) => f.carriedKey), 'a request to the API carried no key');
});

test('a database the organization does not license is refused cleanly', { skip: NO_KEY }, async (t) => {
    const target = await unlicensedFile();
    if (target.skip !== undefined) {
        t.skip(target.skip);
        return;
    }
    const before = requestLog().length;

    await assert.rejects(stagingClient().database.downloadUrl(target.id, target.format), (err) => {
        assert.ok(err instanceof InternetDataError, 'a refusal must arrive as the library error type');
        assert.equal(err.kind, 'forbidden');
        assert.equal(err.status, 403);
        assert.equal(err.retryable, false, 'a licence refusal is not worth retrying');
        // The API says which refusal this is (`{"rc":"NOT_LICENSED"}`). Falling
        // back to the status means the client never read the envelope.
        assert.ok(
            !err.message.startsWith('request failed with status'),
            'the message is the client fallback, so the response body went unread',
        );
        return true;
    });

    assert.equal(requestLog().length - before, 1, 'a 4xx must not be retried');
});

// v1 streams the bytes through the API, so its only "URL" is the endpoint plus
// the key. v2 answers a redirect to presigned object storage, which is what
// makes a credential-free link possible at all - so the link must not carry the
// key, and this method must not follow it.
test('downloadUrl hands back a credential-free link', { skip: NO_KEY }, async (t) => {
    const target = await smallestLicensedFile();
    if (target.skip !== undefined) {
        t.skip(target.skip);
        return;
    }

    const url = await stagingClient().database.downloadUrl(target.id, target.format);
    const parsed = new URL(url);

    assert.notEqual(parsed.origin, STAGING_ORIGIN, 'the link still points at the API');
    assert.ok(
        parsed.searchParams.has('X-Amz-Signature') || parsed.searchParams.has('Signature'),
        'the link carries no signature, so it is not presigned',
    );
    assert.ok(!requestLog().some((f) => f.origin === parsed.origin),
        'downloadUrl followed the redirect, which would have moved the whole file');
});

test('download streams a real database to disk intact', { skip: NO_KEY }, async (t) => {
    const dl = await downloaded();
    if (dl.skip !== undefined) {
        t.skip(dl.skip);
        return;
    }

    assert.ok(dl.bytes > 0, 'nothing was transferred');
    assert.equal(dl.bytes, dl.size, 'the transfer is not the length metadata published');
    assert.equal(statSync(dl.path).size, dl.bytes, 'the file is not the length the method reported');
    assert.equal(existsSync(`${dl.path}.part`), false, 'the .part file outlived a successful transfer');
    if (dl.format === 'csvgz') {
        assert.deepEqual([...readFileSync(dl.path).subarray(0, 2)], [0x1f, 0x8b], 'the payload is not gzip');
    }

    assert.match(dl.checksums.sha256, /^[0-9a-f]{64}$/, 'checksums must unwrap past the envelope');
    assert.equal(sha256(readFileSync(dl.path)), dl.checksums.sha256, 'the bytes are not the published file');

    // The presigned URL authorizes itself, so the transfer must carry no
    // credential: fetch keeps a custom header across a cross-origin redirect
    // even though it strips Authorization.
    const storage = requestLog().filter((f) => f.origin !== STAGING_ORIGIN);
    assert.ok(storage.length > 0, 'nothing was fetched from object storage, so no 302 was followed');
    for (const fact of storage) {
        assert.equal(fact.carriedKey, false, 'the API key was sent to object storage');
    }
});

test('downloadBytes agrees with the streamed copy, byte for byte', { skip: NO_KEY }, async (t) => {
    const dl = await downloaded();
    if (dl.skip !== undefined) {
        t.skip(dl.skip);
        return;
    }

    const bytes = await stagingClient().database.downloadBytes(dl.id, dl.format);

    assert.equal(bytes.length, dl.bytes, 'the in-memory copy is a different length');
    assert.equal(sha256(bytes), dl.checksums.sha256, 'the in-memory copy is not the published file');
});

test('the download history answers in the published shape', { skip: NO_KEY }, async () => {
    const rows = await stagingClient().database.downloads({ limit: 5 });

    assert.ok(Array.isArray(rows), 'downloads must answer a list');
    assert.ok(rows.length <= 5, 'the limit was not honoured');
    for (const row of rows) {
        assert.equal(typeof row.dataset_id, 'string');
        assert.equal(typeof row.format, 'string');
        assert.ok(
            ['ok', 'unauthorized', 'denied', 'expired', 'unknown', 'unavailable'].includes(row.outcome),
            `an attempt carries undocumented outcome ${row.outcome}`,
        );
        assert.ok(!Number.isNaN(Date.parse(row.created)), `${row.dataset_id} has an unparseable created`);
    }
});

// Memoized so the two transfer tests share one download rather than pulling the
// file twice each.
function downloaded() {
    if (transfer === null) {
        transfer = download();
    }
    return transfer;
}

async function download() {
    const target = await smallestLicensedFile();
    if (target.skip !== undefined) {
        return target;
    }

    const path = join(tmp, `${target.id}.${target.format}`);
    const bytes = await stagingClient().database.download(target.id, target.format, path);
    // Read AFTER the transfer, so a rebuild between the two calls shows up as a
    // digest mismatch rather than passing against a digest of nothing.
    const checksums = await stagingClient().database.checksums(target.id, target.format);
    console.log(`${target.id}.${target.format}: ${bytes} bytes, metadata said ${target.size}`);
    return { ...target, path: path, bytes: bytes, checksums: checksums };
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
