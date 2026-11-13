// The published package looking an address, an AS and a domain up against the
// live API: keyless on prod and staging, and on staging with the CI key, whose
// organization is on the free plan, so its answer is a paid one while the day's
// trial lasts and Unlimited's after.
//
// What a served answer must satisfy whatever the plan: every member the spec
// requires; a member the plan leaves out is ABSENT, never false or empty; an
// empty detail object means its flag is false.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// A namespace import, because a named import of an export the installed version
// lacks fails the whole file at link time instead of skipping.
import * as internetdata from '@internetdata/internetdata';

import { skipForNoKey, stagingKey } from '../lib/key.mjs';
import { INSTALLED_VERSION, needsVersion, requestFacts } from '../lib/staging.mjs';

const NOT_YET = needsVersion('2.9.0', 'the lookups');
const NO_KEY = NOT_YET || skipForNoKey();

const PROD_API = 'https://api.internetdata.io';
const STAGING_API = 'https://api-staging.internetdata.io';

// A stable hosting address, and the one the README teaches.
const PROBE = '146.70.116.130';

const FLAGS = [
    'is_bogon', 'is_tor', 'is_relay', 'is_anycast', 'is_carrier', 'is_satellite', 'is_ssh', 'is_smtp', 'is_web',
    'is_dns_resolver', 'is_bittorrent',
];
// Paid plans and the trial only: absent from an Unlimited answer.
const PAID = ['is_vpn', 'is_hosting', 'vpn', 'hosting', 'whois', 'rwhois', 'hosted_domains'];
const PAID_IN = { location: ['city', 'latitude'], asn: ['rpki_status'], company: ['type'], abuse: ['phone'] };

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function clientFor(baseUrl, key, onRequest = () => {}) {
    return new internetdata.InternetData({
        ...(baseUrl === undefined ? {} : { baseUrl: baseUrl }),
        ...(key === '' ? {} : { apiKey: key }),
        fetch: async (...args) => {
            onRequest({ ...requestFacts(args, key), ips: await batchAddresses(args) });
            return fetch(...args);
        },
    });
}

// The addresses a POST carried, read off a CLONE so the request still sends its
// body. Addresses are the one part of a body worth remembering, and no secret.
async function batchAddresses(args) {
    const input = args[0];
    if (typeof input === 'string' || input.method !== 'POST') {
        return undefined;
    }
    return JSON.parse(await input.clone().text()).ips;
}

function assertUnlimited(result, label) {
    assert.equal(result.ip, PROBE, label);
    for (const flag of FLAGS) {
        assert.equal(typeof result[camel(flag)], 'boolean', `${label}: ${flag} is required`);
    }
    assert.equal(result.isBogon, false, label);
    for (const member of PAID) {
        assert.ok(!(member in result.raw), `${label}: ${member} is served without a key`);
        assert.ok(!(camel(member) in result), `${label}: ${member} must be absent, not false or empty`);
    }
    for (const [object, members] of Object.entries(PAID_IN)) {
        for (const member of members) {
            assert.ok(!(member in result[object]), `${label}: ${object}.${member} must be absent`);
        }
    }
    assert.deepEqual(result.tor, result.isTor ? result.tor : {}, `${label}: tor is {} when is_tor is false`);
}

for (const [env, baseUrl] of [['prod', undefined], ['staging', STAGING_API]]) {
    test(`a keyless lookup on ${env} is Unlimited's answer`, { skip: NOT_YET }, async () => {
        const sent = [];
        const keyless = clientFor(baseUrl, '', (fact) => sent.push(fact));

        assertUnlimited(await keyless.lookup(PROBE), env);
        assert.deepEqual(sent.map((f) => `${f.origin}${f.path}`), [`${baseUrl ?? PROD_API}/${PROBE}`]);
        console.log(`testing @internetdata/internetdata@${INSTALLED_VERSION} against ${baseUrl ?? PROD_API}`);
    });

    test(`a keyless AS and domain lookup on ${env} leave the paid members out`, { skip: NOT_YET }, async () => {
        const keyless = clientFor(baseUrl, '');

        const asn = await keyless.lookupAsn(9009);
        assert.equal(asn.asn, 9009);
        assert.equal(typeof asn.registry, 'string');
        for (const member of ['numIps', 'whois', 'prefixes']) {
            assert.ok(!(member in asn), `${env}: ${member} must be absent without a key`);
        }
        const domain = await keyless.lookupDomain('example.com');
        assert.equal(domain.domain, 'example.com');
        assert.equal(typeof domain.isRegistered, 'boolean');
        for (const member of ['isDisposable', 'dns', 'ipRanges']) {
            assert.ok(!(member in domain), `${env}: ${member} must be absent without a key`);
        }
    });

    test(`myIp on ${env} answers the address it saw`, { skip: NOT_YET }, async () => {
        const me = await clientFor(baseUrl, '').myIp();
        assert.equal(typeof me.ip, 'string');
        assert.equal(me.isBogon, false);
    });
}

test('a bogon is answered without touching the network', { skip: NOT_YET }, async () => {
    const offline = new internetdata.InternetData({
        fetch: () => {
            throw new Error('the bogon path reached the network');
        },
    });

    const r = await offline.lookup('10.0.0.1');

    assert.equal(r.isBogon, true);
    assert.equal(r.isVpn, false);
    assert.deepEqual(r.vpn, {});
    assert.deepEqual(r.web, []);
    assert.equal(internetdata.isBogon('10.0.0.1'), true, 'the standalone export must agree');
});

test('a keyless batch is refused as unauthorized, once, and its bogon still answered', { skip: NOT_YET }, async () => {
    const sent = [];
    const keyless = clientFor(STAGING_API, '', (fact) => sent.push(fact));

    // Two addresses on the wire: a keyless batch of one is answered as its lookup.
    const got = await keyless.lookupBatch([PROBE, '8.8.8.8', '10.0.0.1']);

    assert.equal(got.get('10.0.0.1').isBogon, true);
    for (const ip of [PROBE, '8.8.8.8']) {
        const refused = got.get(ip);
        assert.ok(refused instanceof internetdata.InternetDataError, `${ip}: a batch without a key must fail`);
        assert.equal(refused.kind, 'unauthorized');
        assert.equal(refused.status, 401);
        assert.equal(refused.retryable, false);
    }
    assert.deepEqual(sent.map((f) => f.path), ['/batch'], 'one request, never retried');
    assert.deepEqual([...sent[0].ips].sort(), [PROBE, '8.8.8.8'].sort(), 'the bogon stayed off the wire');
});

// The authorization server is the apex, so a client on the API host signs in there.
test('a client on the API host authenticates at the apex', { skip: NOT_YET }, async () => {
    const sent = [];
    const metadata = await clientFor(STAGING_API, '', (fact) => sent.push(fact)).oauth.metadata();

    assert.equal(metadata.issuer, 'https://staging.internetdata.io');
    assert.deepEqual(sent.map((f) => f.origin), ['https://staging.internetdata.io']);
});

test("the CI key's lookup is a paid one or Unlimited's, and says which", { skip: NO_KEY }, async () => {
    const sent = [];
    const keyed = clientFor(STAGING_API, stagingKey(), (fact) => sent.push(fact));

    const result = await keyed.lookup(PROBE);

    // Without this the answer is indistinguishable from a keyless one.
    assert.ok(sent.length > 0 && sent.every((f) => f.carriedKey), 'the key never reached the wire');
    assert.equal(result.ip, PROBE);
    assert.equal(typeof result.trialExpired, 'boolean', 'a free-plan key answers trial_expired');
    // The organization's first 100 lookups of the UTC day are answered in full,
    // and the rest as Unlimited's: which half a run sees depends on the day.
    assert.equal('is_vpn' in result.raw, !result.trialExpired, 'is_vpn is served exactly while the trial lasts');
    assert.equal('isVpn' in result, !result.trialExpired);
});

test("the CI key's entitlement names its plan and its usage", { skip: NO_KEY }, async () => {
    const sent = [];
    const ent = await clientFor(STAGING_API, stagingKey(), (fact) => sent.push(fact)).myEntitlement();

    assert.ok(sent.length > 0 && sent.every((f) => f.carriedKey), 'the key never reached the wire');
    assert.equal(typeof ent.plan.key, 'string');
    assert.equal(typeof ent.usage.requests, 'number');
    assert.ok(ent.usage.hard_limit === null || typeof ent.usage.hard_limit === 'number');
});

test("the CI key's batch of two is refused as a bad request, once", { skip: NO_KEY }, async () => {
    const sent = [];
    const keyed = clientFor(STAGING_API, stagingKey(), (fact) => sent.push(fact));

    const got = await keyed.lookupBatch([PROBE, '8.8.8.8']);

    for (const ip of [PROBE, '8.8.8.8']) {
        const refused = got.get(ip);
        assert.ok(refused instanceof internetdata.InternetDataError, `${ip}: a free-plan batch of two must fail`);
        assert.equal(refused.kind, 'bad_request');
        assert.equal(refused.status, 402);
        assert.equal(refused.retryable, false);
    }
    assert.deepEqual(sent.map((f) => f.path), ['/batch'], 'one request, never retried');
    assert.ok(sent[0].carriedKey, 'the key never reached the wire');
});

test("the CI key's batch of one is answered", { skip: NO_KEY }, async () => {
    const got = await clientFor(STAGING_API, stagingKey()).lookupBatch(['8.8.4.4']);

    const answer = got.get('8.8.4.4');
    assert.ok(!(answer instanceof Error), `8.8.4.4 failed: ${answer?.message}`);
    assert.equal(typeof answer.trialExpired, 'boolean');
});
