// The staging fixtures the test files share: the client, what a test is allowed
// to remember about a request, and the two targets everything else is derived
// from.

import { InternetData } from '@internetdata/internetdata';

import { stagingKey } from './key.mjs';

export const STAGING = 'https://staging.internetdata.io';
export const STAGING_ORIGIN = new URL(STAGING).origin;

// 8 MiB. The staging organization is licensed for the two smallest published
// families, a few hundred bytes each, so this is four orders of magnitude of
// headroom - tripping it means the suite is pointed at something unintended,
// which is exactly when a transfer must not go ahead. Published builds reach
// several GiB, and the whole point of checking `metadata` first is that a
// mistaken id can never quietly pull one of them through CI.
export const CEILING = 8 * 1024 * 1024;

const facts = [];

let client = null;

export function stagingClient() {
    if (client === null) {
        client = new InternetData({
            apiKey: stagingKey(),
            baseUrl: STAGING,
            fetch: (...args) => {
                facts.push(requestFacts(args, stagingKey()));
                return fetch(...args);
            },
        });
    }
    return client;
}

/** Every request this run has made, as derived facts only. */
export function requestLog() {
    return facts;
}

/**
 * What a test is allowed to remember about a request it made.
 *
 * Only derived facts leave here. An assertion that fails prints its operands,
 * and these logs are public, so holding on to the Request itself is how a key
 * ends up in a CI log: whether the key was carried is a boolean, and the caller
 * never sees the key.
 */
export function requestFacts(args, key) {
    const input = args[0];
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    const headers = input?.headers ?? new Headers(args[1]?.headers ?? {});
    const carriedKey = key !== ''
        && (url.includes(key) || [...headers.values()].some((v) => v.includes(key)));
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname, carriedKey: carriedKey };
}

// One listing for the whole run. Nothing here is memoized inside the library -
// a catalog is per key and per moment - so the memo lives in the suite, where
// its scope is one process against one key.
let catalog = null;

export function databases() {
    if (catalog === null) {
        catalog = stagingClient().database.list();
    }
    return catalog;
}

/**
 * The smallest licensed file this run may move, or a skip reason.
 *
 * Derived rather than named: which families the CI organization holds is a
 * property of the staging database, and a hardcoded id turns a licence change
 * into a red build that says nothing about the client. The size comes from
 * `metadata` BEFORE any transfer, so the ceiling is enforced rather than hoped
 * for.
 */
export async function smallestLicensedFile() {
    const licensed = (await databases()).filter((db) => db.standing === 'licensed');
    if (licensed.length === 0) {
        return { skip: 'the staging organization licenses nothing, so no transfer is possible' };
    }

    let best = null;
    for (const db of licensed) {
        for (const version of db.versions) {
            const meta = await stagingClient().database.metadata(version.id);
            for (const format of version.formats) {
                const size = meta.size?.[format];
                if (typeof size !== 'number' || size <= 0 || size > CEILING) {
                    continue;
                }
                if (best === null || size < best.size) {
                    best = { id: version.id, format: format, size: size };
                }
            }
        }
    }
    if (best === null) {
        return {
            skip: `nothing licensed publishes a file at or under the ${CEILING} byte ceiling`,
        };
    }
    return best;
}

/**
 * A real catalog id this organization holds no licence for, or a skip reason.
 *
 * Taken from the listing too, so the refusal test cannot go stale by naming a
 * family that has since been bought.
 */
export async function unlicensedFile() {
    for (const db of await databases()) {
        if (db.standing !== 'unlicensed') {
            continue;
        }
        for (const version of db.versions) {
            if (version.formats.length > 0) {
                return { id: version.id, format: version.formats[0] };
            }
        }
    }
    return { skip: 'every listed family is licensed, so there is nothing to be refused' };
}
