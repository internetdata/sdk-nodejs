import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';

import type { Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { createClient, createConfig } from './generated/client/index.js';
import type { Client } from './generated/client/index.js';
import {
    databaseChecksumV2, databaseMetadataV2, downloadDatabaseV2 as downloadRedirect,
    listDatabases, listDownloads, lookupAsn, lookupBatch, lookupDomain, lookupIp, lookupMyIp, myEntitlement,
} from './generated/sdk.gen.js';
import type {
    AsnLookupResponse, BatchLookupResponse, DatabaseChecksumV2Responses, DatabaseMetadataV2Responses,
    DomainLookupResponse, Entitlement, ListDatabasesResponses, ListDownloadsResponses, LookupResponse,
} from './generated/types.gen.js';

import { bogonResult, isBogon, unmapped } from './bogon.js';
import { errorFromEntry, errorFromResponse, InternetDataError } from './errors.js';
import { OauthApi } from './oauth.js';
import {
    isAsnLookup, isBatch, isBatchError, isChecksumsResponse, isDatabaseList, isDatabaseMetadata,
    isDomainLookup, isDownloadList, isEntitlement, isLookup,
} from './shapes.js';
import {
    asError, checkConcurrency, checkRetries, checkTimeout, deadline, readable, unwrap, withRetry,
} from './transport.js';
import { DATABASE_FORMATS, toAsnResult, toDomainResult, toResult } from './types.js';
import type {
    AsnResult, Database, DatabaseFormat, DatabaseMetadata, DbChecksums, DomainResult, Download, Result,
} from './types.js';

/**
 * Where `download` puts the bytes: a path to write, or a stream you opened
 * yourself and will close yourself.
 */
export type DownloadDestination = string | Writable;

export const DEFAULT_BASE_URL = 'https://api.internetdata.io';

// Matches the other SDKs, whose HTTP clients default to 30s. Node's global
// fetch has no whole-request limit of its own, so without this a hung API holds
// a caller until undici's 300s headers timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

// The most addresses POST /batch takes in one call; a larger batch is sent in
// chunks of this size.
const BATCH_MAX = 1000;

export interface CacheOptions {
    /** Maximum number of addresses held. Default 10000. */
    max?: number;
    /** How long an answer stays fresh, in milliseconds. Default 1 hour. */
    ttlMs?: number;
}

export interface DownloadsOptions {
    /** How many attempts to return, newest first. The API clamps this to 200. */
    limit?: number;
    /**
     * How long one attempt may take before it is abandoned, in milliseconds, for
     * THIS call only. Defaults to the client's `timeoutMs`.
     */
    timeoutMs?: number;
}

/** Which file `downloadUrl` links to, and how long it may take. */
export interface DownloadUrlOptions {
    /**
     * One build of the database, by the name a `database.updated` webhook gives
     * it (`20261105.0t53s5`), so the file is the one whose `sha256` the webhook
     * carries. Omit it for the build that is live. A build is kept 7 days; past
     * that the call fails as `bad_request` with the message `BUILD_GONE`.
     */
    build?: string;
    /**
     * How long one attempt may take before it is abandoned, in milliseconds, for
     * THIS call only. Defaults to the client's `timeoutMs`.
     */
    timeoutMs?: number;
}

/**
 * Which file `download` and `downloadBytes` fetch. A transfer takes no
 * `timeoutMs`: it runs as long as the file does.
 */
export interface DownloadOptions {
    /** One build of the database, as `DownloadUrlOptions.build` says. */
    build?: string;
}

export interface Options {
    /**
     * Your API key. Without one a lookup is on Unlimited, the free plan, limited
     * per address per minute, and no `Authorization` header is sent at all. The
     * database calls need a key carrying the `db.download` scope. A batch needs
     * a key on a paid plan.
     */
    apiKey?: string;
    /**
     * Default `https://api.internetdata.io`. The `oauth` calls go to the apex
     * this names: `api.` dropped, and `api-<env>.` read as `<env>.`.
     */
    baseUrl?: string;
    /** Pass `false` to disable caching. */
    cache?: CacheOptions | false;
    /**
     * Concurrent batch requests - chunks of up to 1000 addresses - during a
     * batch, a whole number from 1. Default 8.
     */
    concurrency?: number;
    /** Retry attempts for a transient failure, a whole number from 0. Default 2. */
    retries?: number;
    /**
     * How long one API call may take before it is abandoned, in milliseconds.
     * Default 30000, per attempt, so a retried call may take longer in total.
     * A value outside 1 to 2147483647 is refused as `bad_request`.
     *
     * **A dataset transfer is deliberately exempt.** It is a sane bound on a
     * metadata call and the wrong one on a body that reaches gigabytes.
     */
    timeoutMs?: number;
    /** Override the HTTP implementation, mostly for tests. */
    fetch?: typeof globalThis.fetch;
}

/** Per-call overrides for a single lookup. Anything omitted falls back to the client's setting. */
export interface LookupOptions {
    /** Retry attempts for a transient failure, a whole number from 0. */
    retries?: number;
    /** How long one attempt may take before it is abandoned, in milliseconds. */
    timeoutMs?: number;
}

/** Per-call overrides for one batch. Anything omitted falls back to the client's setting. */
export interface BatchOptions extends LookupOptions {
    /** Concurrent batch requests for THIS batch only. */
    concurrency?: number;
}

/**
 * A client for the InternetData API.
 *
 * The cache is per instance, so an answer is never shared between two clients
 * holding different API keys and therefore entitled to different fields.
 *
 * Everything the database calls answer is scoped to the organization the key
 * belongs to, including which databases are listed at all, so one client speaks
 * for exactly one organization and nothing it learns may be reused for another
 * key. The key is optional, and an absent one sends no `Authorization` header
 * rather than an empty one. `oauth` needs none.
 */
export class InternetData {
    private readonly client: Client;
    // Keyed by address. The context is how a call sends the request when the
    // address has none in flight: `fetch()` runs it synchronously, so a batch
    // knows which addresses it leads before it builds a chunk.
    private readonly cache: LRUCache<string, Result, () => Promise<Result>> | null;
    private readonly limit: ReturnType<typeof pLimit>;
    private readonly retries: number;
    private readonly timeoutMs: number;

    /** The database catalog, downloads and their history. */
    readonly database: DatabaseApi;

    /**
     * Sign a person in with the OAuth device flow, so a program on their own
     * machine can be handed one of their API keys. Needs no API key.
     */
    readonly oauth: OauthApi;

    constructor(options: Options = {}) {
        // Resolved once, because the download path calls object storage
        // directly rather than through the generated client and has to reach
        // the same implementation a test substituted.
        const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        const apiKey = checkApiKey(options.apiKey);
        // Every path appended starts with a slash, and a second one is another
        // path, which the API answers with a redirect.
        const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.client = createClient(createConfig({
            baseUrl: baseUrl,
            ...(apiKey === undefined ? {} : { auth: bearerOnly(apiKey) }),
            fetch: fetchImpl,
        }));
        this.cache = options.cache === false ? null : new LRUCache<string, Result, () => Promise<Result>>({
            max: options.cache?.max ?? 10_000,
            ttl: options.cache?.ttlMs ?? 60 * 60 * 1000,
            // Concurrent misses for one address share one request: every
            // `fetch()` while it is in flight gets the same promise, and a
            // failure rejects them all and is cached for none.
            fetchMethod: (_ip, _stale, { context }) => context(),
            // An eviction must not fail the callers awaiting a request.
            ignoreFetchAbort: true,
        });
        this.limit = pLimit(checkConcurrency(options.concurrency) ?? 8);
        this.retries = checkRetries(options.retries) ?? 2;
        this.timeoutMs = checkTimeout(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
        this.database = new DatabaseApi(this.client, this.retries, this.timeoutMs, fetchImpl);
        // The authorization server is the apex, not the API host, and its
        // requests carry no credential at all.
        const authServer = createClient(createConfig({ baseUrl: apexOf(baseUrl), fetch: fetchImpl }));
        this.oauth = new OauthApi(authServer, this.retries, this.timeoutMs);
    }

    /**
     * Whether an address is private, loopback, link-local, documentation,
     * multicast or otherwise not routable, including the IPv6 equivalents and
     * the 6to4 and Teredo ranges.
     *
     * These are the addresses `lookup` answers locally. Exposed here so the
     * check is reachable from the client you already hold; the same function is
     * also importable on its own.
     */
    isBogon(ip: string): boolean {
        return isBogon(ip);
    }

    /**
     * What every database says about one address.
     *
     * A bogon is answered locally and never reaches the network. Everything
     * else is served, then cached for this instance. Calls that miss the cache
     * while a request for their address is in flight, a batch's included, await
     * that request rather than sending their own, and take its answer, sent
     * under the options of the call that led it. An IPv4-mapped address
     * (`::ffff:8.8.8.8`) is the IPv4 address it carries: judged, sent and cached
     * as that, so the answer names `8.8.8.8`.
     */
    async lookup(ip: string, options: LookupOptions = {}): Promise<Result> {
        // First, or a bogon and a cached address would answer any value.
        checkTimeout(options.timeoutMs);
        checkRetries(options.retries);
        const addr = unmapped(ip);
        if (isBogon(addr)) {
            return bogonResult(addr);
        }
        if (this.cache === null) {
            return this.serve(addr, options);
        }
        return (await this.cache.fetch(addr, { context: () => this.serve(addr, options) }))!;
    }

    private async serve(ip: string, options: LookupOptions): Promise<Result> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        return withRetry(options.retries ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupIp({
                client: this.client, path: { ip: ip }, signal: signal,
            }));
            return toResult(readable<LookupResponse>(res, isLookup));
        });
    }

    /**
     * What the databases say about the address this client is calling from.
     *
     * The same answer `lookup` would give for that address, at the same cost
     * against your allowance. The address is the one our edge observed, so a
     * call made through a proxy or a VPN reports the exit it left through -
     * usually the point of asking.
     *
     * Deliberately NOT cached. The cache is keyed by address, and which
     * address this is IS the question: a machine that moves between networks
     * would otherwise be told where it used to be.
     */
    async myIp(options: LookupOptions = {}): Promise<Result> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(checkRetries(options.retries) ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupMyIp({
                client: this.client, signal: signal,
            }));
            return toResult(readable<LookupResponse>(res, isLookup));
        });
    }

    /**
     * What InternetData knows about one autonomous system, by its number: its
     * registration on every plan, and on a paid one its ASN Whois record and
     * every prefix it announces.
     *
     * Sent as given and not cached. The API refuses a number it cannot read as
     * `bad_request`.
     */
    async lookupAsn(asn: number, options: LookupOptions = {}): Promise<AsnResult> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(checkRetries(options.retries) ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupAsn({
                client: this.client, path: { asn: String(asn) }, signal: signal,
            }));
            return toAsnResult(readable<AsnLookupResponse>(res, isAsnLookup));
        });
    }

    /**
     * What InternetData knows about one domain: on every plan whether it is
     * registered and which DNS record types it has, and on a paid one the
     * records themselves, its organization's IP ranges and whether it is a
     * disposable email domain.
     *
     * Sent as given and not cached. The API refuses a name it cannot read as
     * `bad_request`.
     */
    async lookupDomain(domain: string, options: LookupOptions = {}): Promise<DomainResult> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(checkRetries(options.retries) ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => lookupDomain({
                client: this.client, path: { domain: domain }, signal: signal,
            }));
            return toDomainResult(readable<DomainLookupResponse>(res, isDomainLookup));
        });
    }

    /**
     * What this client's key is entitled to, and how much of it has been used.
     *
     * Named for what it answers rather than `me`, which sits one letter from
     * `myIp` and means something quite different: one is which address you are
     * calling FROM, the other is what the key you are calling WITH may spend.
     *
     * Unlike a lookup there is no useful unauthenticated answer, so a client
     * built without a key gets an unauthorized error rather than a partial one.
     *
     * Usage counts against the ALLOWANCE WINDOW - on a paid plan the
     * anniversary of the subscription, not the calendar month and not the
     * billing period, and on the free plan the UTC day - and it is the same
     * number a lookup is gated on. It can lag by a few seconds, because
     * requests are counted in memory and flushed in aggregate.
     *
     * Deliberately NOT cached: the whole point is what has been spent, and a
     * cached answer is a wrong one within seconds of the next request.
     */
    async myEntitlement(options: LookupOptions = {}): Promise<Entitlement> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(checkRetries(options.retries) ?? this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => myEntitlement({
                client: this.client, signal: signal,
            }));
            return readable<Entitlement>(res, isEntitlement);
        });
    }

    /**
     * Look many addresses up in as few requests as possible.
     *
     * Bogons are answered locally and cached answers are reused, and an address
     * with a request already in flight, a lookup's or another batch's, awaits
     * that request; everything else goes to the batch endpoint in chunks of up
     * to 1000 addresses, with at most `concurrency` chunks in flight, and a
     * lookup arriving meanwhile awaits this batch's answer for its address.
     * Keyed by address rather than positional, so duplicates in the input
     * collapse to a single entry and the caller never has to line two lists up.
     * An address that fails carries its error as its value, so one bad entry
     * cannot lose the rest of the answers: the API reports a per-entry failure
     * with the status the single lookup would have answered, and a chunk that
     * fails as a whole marks every address in it. A per-call `concurrency` that
     * is not a whole number from 1 is refused as `bad_request` before anything
     * is sent. An IPv4-mapped address is looked up as the IPv4 address it
     * carries, and its answer keyed as you passed it. The batch endpoint needs
     * a paid plan: without a key every address in a request of two or more
     * carries an `unauthorized` error, and a free-plan key's request of two or
     * more a `bad_request` (HTTP 402). A request of one address is answered as
     * its lookup would be.
     */
    async lookupBatch(
        ips: Iterable<string>, options: BatchOptions = {},
    ): Promise<Map<string, Result | InternetDataError>> {
        const concurrency = checkConcurrency(options.concurrency);
        checkTimeout(options.timeoutMs);
        checkRetries(options.retries);
        const asked = [...new Set(ips)];
        const unique = [...new Set(asked.map(unmapped))];
        const out = new Map<string, Result | InternetDataError>();
        const pending: string[] = [];
        // Every address that is neither a bogon nor cached goes through
        // `fetch()` in one synchronous pass: one with a request in flight joins
        // it, and for the rest `fetchMethod` runs at once, which is how this
        // batch learns the addresses it leads before building any chunk.
        const shared: [string, Promise<Result | undefined>][] = [];
        const led = new Map<string, PromiseWithResolvers<Result>>();
        for (const ip of unique) {
            if (isBogon(ip)) {
                out.set(ip, bogonResult(ip));
                continue;
            }
            const hit = this.cache?.get(ip);
            if (hit !== undefined) {
                out.set(ip, hit);
                continue;
            }
            if (this.cache === null) {
                pending.push(ip);
                continue;
            }
            shared.push([ip, this.cache.fetch(ip, {
                context: () => {
                    const landing = Promise.withResolvers<Result>();
                    led.set(ip, landing);
                    pending.push(ip);
                    return landing.promise;
                },
            })]);
        }
        // A per-call concurrency gets its own limiter; without one the call
        // would share the instance's budget and silently ignore the override.
        const limit = concurrency === undefined ? this.limit : pLimit(concurrency);
        const chunks: string[][] = [];
        for (let i = 0; i < pending.length; i += BATCH_MAX) {
            chunks.push(pending.slice(i, i + BATCH_MAX));
        }
        await Promise.all([
            ...chunks.map((chunk) => limit(async () => {
                for (const [ip, answer] of await this.lookupChunk(chunk, options)) {
                    const landing = led.get(ip);
                    if (landing === undefined) {
                        out.set(ip, answer);
                    } else if (answer instanceof InternetDataError) {
                        landing.reject(answer);
                    } else {
                        landing.resolve(answer);
                    }
                }
            })),
            ...shared.map(async ([ip, answer]) => {
                try {
                    out.set(ip, (await answer)!);
                } catch (err) {
                    out.set(ip, asError(err));
                }
            }),
        ]);
        // Reinstated in input order, under the addresses as passed: chunks
        // settle in completion order, and a caller iterating the map should see
        // what they passed in.
        return new Map(asked.map((ip) => [ip, out.get(unmapped(ip))!]));
    }

    // One POST /batch, mapped back onto the addresses it was asked about. A
    // chunk-level failure - the call refused, the transport failing, the
    // retries exhausted - becomes every address's error, exactly as it would
    // have been had each been looked up alone.
    private async lookupChunk(
        chunk: string[], options: LookupOptions,
    ): Promise<Map<string, Result | InternetDataError>> {
        const out = new Map<string, Result | InternetDataError>();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        let body: BatchLookupResponse;
        try {
            body = await withRetry(options.retries ?? this.retries, async () => {
                const res = await deadline(timeoutMs, (signal) => lookupBatch({
                    client: this.client, body: { ips: chunk }, signal: signal,
                }));
                return readable<BatchLookupResponse>(res, isBatch);
            });
        } catch (err) {
            const failure = asError(err);
            for (const ip of chunk) {
                out.set(ip, failure);
            }
            return out;
        }
        // An entry is judged alone: one the client cannot read is that address's
        // error, and the rest of the chunk keeps its answers. Each map is read by
        // its own keys alone, so `__proto__`, `constructor` and `toString` never
        // read the object's prototype as a served answer.
        for (const ip of chunk) {
            const served = Object.hasOwn(body.results, ip) ? body.results[ip] : undefined;
            if (served !== undefined) {
                // Cached by the `fetch()` this batch leads it through.
                out.set(ip, isLookup(served) ? toResult(served as LookupResponse) : unreadableEntry(ip));
                continue;
            }
            const failed = Object.hasOwn(body.errors, ip) ? body.errors[ip] : undefined;
            if (failed !== undefined) {
                out.set(ip, isBatchError(failed) ? errorFromEntry(failed) : unreadableEntry(ip));
                continue;
            }
            out.set(ip, new InternetDataError(
                'server_error', `the batch answer did not include ${ip}`, 200,
            ));
        }
        return out;
    }
}

/**
 * The host the `oauth` calls go to: the apex, since the authorization server is
 * mounted there and not on the API host. `https://api.internetdata.io` is
 * `https://internetdata.io` and `https://api-<env>.internetdata.io` is
 * `https://<env>.internetdata.io`; any other base URL is used as given.
 */
function apexOf(baseUrl: string): string {
    return baseUrl.replace(/^(https?:\/\/)api(?:-([^./:@]+))?\./i, (_, scheme: string, env?: string) => (
        env === undefined ? scheme : `${scheme}${env}.`
    ));
}

function unreadableEntry(ip: string): InternetDataError {
    return new InternetDataError('server_error', `unreadable batch answer for ${ip}, status 200`, 200);
}

/** The licensed database downloads. Access is granted by contract, not self-serve. */
export class DatabaseApi {
    constructor(
        private readonly client: Client,
        private readonly retries: number,
        private readonly timeoutMs: number,
        private readonly fetchImpl: typeof globalThis.fetch,
    ) {}

    /**
     * The published catalog as your organization may see it, one entry per
     * database FAMILY, with `standing` saying where your license stands.
     *
     * This is the server's answer for this key, and it is not cached: ask again
     * rather than holding on to it, and never carry one key's answer over to
     * another.
     */
    async list(): Promise<Database[]> {
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => listDatabases({
                client: this.client, signal: signal,
            }));
            return readable<ListDatabasesResponses[200]>(res, isDatabaseList).databases;
        });
    }

    /**
     * What is inside one database: its columns per format, sample rows, the row
     * count, the byte size of each file, and the day it was last built.
     *
     * The cheap way to decide whether today's build is worth fetching, and the
     * only way to know what a transfer will cost before starting it.
     */
    async metadata(id: string): Promise<DatabaseMetadata> {
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => databaseMetadataV2({
                client: this.client, query: { id: id }, signal: signal,
            }));
            return readable<DatabaseMetadataV2Responses[200]>(res, isDatabaseMetadata);
        });
    }

    /**
     * The digests for one database file.
     *
     * Returns the whole set rather than one algorithm: which digests a database
     * publishes is the API's choice, not ours.
     */
    async checksums(id: string, format: DatabaseFormat): Promise<DbChecksums> {
        assertFormat(format);
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => databaseChecksumV2({
                client: this.client, query: { id: id, format: format }, signal: signal,
            }));
            return readable<DatabaseChecksumV2Responses[200]>(res, isChecksumsResponse).checksums;
        });
    }

    /**
     * Your organization's recent download attempts, newest first.
     *
     * Refusals are listed too: a denial is what answers "it stopped working",
     * and its absence answers nothing.
     */
    async downloads(options: DownloadsOptions = {}): Promise<Download[]> {
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => listDownloads({
                client: this.client,
                ...(options.limit === undefined ? {} : { query: { limit: options.limit } }),
                signal: signal,
            }));
            return readable<ListDownloadsResponses[200]>(res, isDownloadList).downloads;
        });
    }

    /**
     * The time-limited URL for one database file.
     *
     * The API answers `302` to object storage. The URL is returned rather than
     * the bytes so the caller decides how to transfer a file that runs to
     * gigabytes; it carries its own authorization, so it can be handed to
     * something that holds no API key. The link authorizes the START of a
     * transfer, so one already running is not interrupted when it lapses.
     */
    async downloadUrl(
        id: string, format: DatabaseFormat, options: DownloadUrlOptions = {},
    ): Promise<string> {
        assertFormat(format);
        const build = checkBuild(options.build);
        const timeoutMs = checkTimeout(options.timeoutMs) ?? this.timeoutMs;
        return withRetry(this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => downloadRedirect({
                client: this.client,
                query: { id: id, format: format, ...(build === undefined ? {} : { build: build }) },
                redirect: 'manual',
                signal: signal,
            }));
            if (res.response === undefined) {
                throw new InternetDataError('network', 'no response from the API');
            }
            const location = res.response.headers.get('location');
            if (res.response.status === 302 && location !== null) {
                return location;
            }
            unwrap<unknown>(res);
            throw new InternetDataError(
                'server_error', 'expected a redirect to object storage', res.response.status,
            );
        });
    }

    /**
     * Download one database file, streaming it to `destination`.
     *
     * `destination` is either a path or a writable stream you opened yourself.
     * A path is written through a neighboring `.part` file and renamed on
     * completion, so a transfer that dies half way leaves no truncated file
     * that reads as a whole database; a stream you pass is written as-is and
     * stays yours to close. Nothing is ever held in memory beyond a single
     * chunk, whatever the file weighs.
     *
     * Returns the number of bytes written.
     *
     * A failure DURING the transfer surfaces as the underlying error rather
     * than an `InternetDataError`: a reset socket and a full disk are different
     * problems and only one of them is ours.
     */
    async download(
        id: string, format: DatabaseFormat, destination: DownloadDestination,
        options: DownloadOptions = {},
    ): Promise<number> {
        const res = await this.fetchDatabaseFile(id, format, options);
        if (res.body === null) {
            throw new InternetDataError(
                'server_error', 'object storage answered with no body', res.status,
            );
        }
        const { Readable } = await import('node:stream');
        const { pipeline } = await import('node:stream/promises');
        // `node:stream/web` and the DOM lib declare the same runtime object as
        // two unrelated types, so `fromWeb` needs it restated.
        const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);

        let bytes = 0;
        async function* counted() {
            for await (const chunk of source) {
                bytes += chunk.length;
                yield chunk;
            }
        }

        if (typeof destination !== 'string') {
            await pipeline(counted(), destination);
            return bytes;
        }
        const { createWriteStream } = await import('node:fs');
        const { rename, unlink } = await import('node:fs/promises');
        const partial = `${destination}.part`;
        try {
            await pipeline(counted(), createWriteStream(partial));
        } catch (err) {
            await unlink(partial).catch(() => {});
            throw err;
        }
        await rename(partial, destination);
        return bytes;
    }

    /**
     * Download one database file and hand back its bytes.
     *
     * **This holds the entire file in memory**, and the catalog spans seven
     * orders of magnitude: the smallest published build is a few hundred bytes,
     * which is nothing, while the largest is over 5 GiB, which will cost you
     * that much resident memory in one allocation and can fail outright. Reach
     * for this at the small end, where the bytes are going straight into a
     * parser; use `download` for anything you have not measured, and `metadata`
     * to measure it before you do.
     */
    async downloadBytes(
        id: string, format: DatabaseFormat, options: DownloadOptions = {},
    ): Promise<Uint8Array> {
        const res = await this.fetchDatabaseFile(id, format, options);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Follows the 302 as a SECOND, unauthenticated request: the presigned URL
    // carries its own authorization, so forwarding the API key would hand a
    // credential to a host that has no business holding it.
    private async fetchDatabaseFile(
        id: string, format: DatabaseFormat, options: DownloadOptions,
    ): Promise<Response> {
        if ((options as DownloadUrlOptions).timeoutMs !== undefined) {
            throw new InternetDataError(
                'bad_request', 'a transfer takes no timeoutMs: it runs as long as the file does',
            );
        }
        const url = await this.downloadUrl(id, format, { build: options.build });
        return withRetry(this.retries, async () => {
            const res = await this.fetchImpl(url);
            if (!res.ok) {
                // Left unread: the status is what separates a lapsed link from
                // a refused one, and the body is not bounded by anything.
                void res.body?.cancel();
                throw errorFromResponse(
                    res.status, res.headers,
                    `object storage refused the download link with status ${res.status}`,
                );
            }
            return res;
        });
    }
}

/**
 * A build's name as the API takes it, and none for an empty one, so a value
 * read from an unset setting downloads the live build.
 */
function checkBuild(build: unknown): string | undefined {
    if (build === undefined || build === '') {
        return undefined;
    }
    if (typeof build !== 'string') {
        throw new InternetDataError('bad_request', `build must be a string, got ${typeof build}`);
    }
    return build;
}

/**
 * The key without the blanks around it, and no key at all for blanks alone,
 * which went out as `Authorization: Bearer` (2.5.1, measured 2026-10-10). A
 * control character inside it is refused here: fetch refuses such a header, so
 * every call failed as a retried `network` error with nothing sent. `null` is no
 * key.
 */
function checkApiKey(apiKey: unknown): string | undefined {
    if (apiKey === undefined || apiKey === null) {
        return undefined;
    }
    if (typeof apiKey !== 'string') {
        throw new InternetDataError('bad_request', `apiKey must be a string, got ${typeof apiKey}`);
    }
    const key = apiKey.trim();
    if (/[\u0000-\u001f\u007f]/.test(key)) {
        throw new InternetDataError('bad_request', 'apiKey must not contain a control character');
    }
    // fetch sends a header as Latin-1 and refuses anything past it, so through 2.7.3
    // such a key failed every call as a retried network error with nothing sent.
    if (/[^\u0000-\u00ff]/.test(key)) {
        throw new InternetDataError('bad_request', 'apiKey must not contain a character past U+00FF');
    }
    return key === '' ? undefined : key;
}

/**
 * Sends the key in the `Authorization` header and nowhere else.
 *
 * The API accepts three credential forms and the spec documents all three, so
 * the generator applies EVERY one of them - putting the key in the query string
 * of every request alongside the headers. A query string is the one place a
 * secret should never be: it lands in access logs, proxy logs and browser
 * history, none of which we control. `?apikey=` exists for a human with curl or
 * a browser bar, not for a client that can set a header.
 *
 * Returning undefined for the other schemes is what suppresses them; the
 * generated `getAuthToken` drops a scheme whose callback yields nothing.
 */
function bearerOnly(apiKey: string): (auth: { scheme?: string }) => string | undefined {
    return (auth) => (auth.scheme === 'bearer' ? apiKey : undefined);
}

/**
 * Refuses a format the API does not publish, before the network sees it.
 *
 * The generated union guards a TypeScript caller at compile time and nobody
 * else: a format arriving from a CLI flag, a form field or a model is a plain
 * string, and without this it costs a round trip and comes back as a 400 whose
 * message names nothing the caller can act on. Every download method reaches the
 * network through `downloadUrl`, so this covers all three of them.
 */
function assertFormat(format: DatabaseFormat): void {
    if (DATABASE_FORMATS.includes(format)) {
        return;
    }
    throw new InternetDataError(
        'bad_request',
        `invalid format ${JSON.stringify(format)}; must be one of ${DATABASE_FORMATS.join(', ')}`,
    );
}
