import type { Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { createClient, createConfig } from './generated/client/index.js';
import type { Client } from './generated/client/index.js';
import {
    databaseChecksumV2, databaseMetadataV2, downloadDatabaseV2 as downloadRedirect,
    listDatabases, listDownloads,
} from './generated/sdk.gen.js';
import type {
    DatabaseChecksumV2Responses, DatabaseMetadataV2Responses, ListDatabasesResponses,
    ListDownloadsResponses,
} from './generated/types.gen.js';

import { errorFromResponse, InternetDataError } from './errors.js';
import { OauthApi } from './oauth.js';
import { deadline, unwrap, withRetry } from './transport.js';
import { DATABASE_FORMATS } from './types.js';
import type {
    Database, DatabaseFormat, DatabaseMetadata, DbChecksums, Download,
} from './types.js';

/**
 * Where `download` puts the bytes: a path to write, or a stream you opened
 * yourself and will close yourself.
 */
export type DownloadDestination = string | Writable;

export const DEFAULT_BASE_URL = 'https://internetdata.io';

// Matches the other SDKs, whose HTTP clients default to 30s. Node's global
// fetch has no whole-request limit of its own, so without this a hung API holds
// a caller until undici's 300s headers timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DownloadsOptions {
    /** How many attempts to return, newest first. The API clamps this to 200. */
    limit?: number;
    /**
     * How long one attempt may take before it is abandoned, in milliseconds, for
     * THIS call only. Defaults to the client's `timeoutMs`.
     */
    timeoutMs?: number;
}

export interface Options {
    /**
     * Your API key, carrying the `db.download` scope. Omit it to send no
     * `Authorization` header at all, which is what a dataset offered without a
     * license would be read with.
     */
    apiKey?: string;
    baseUrl?: string;
    /** Retry attempts for a transient failure. Default 2. */
    retries?: number;
    /**
     * How long one API call may take before it is abandoned, in milliseconds.
     * Default 30000, per attempt, so a retried call may take longer in total.
     *
     * **A dataset transfer is deliberately exempt.** It is a sane bound on a
     * metadata call and the wrong one on a body that reaches gigabytes.
     */
    timeoutMs?: number;
    /** Override the HTTP implementation, mostly for tests. */
    fetch?: typeof globalThis.fetch;
}

/**
 * A client for the InternetData API.
 *
 * Everything the API answers is scoped to the organization the key belongs to,
 * including which databases are listed at all, so one client speaks for exactly
 * one organization and nothing it learns may be reused for another key.
 *
 * The key is optional, and an absent one sends no `Authorization` header rather
 * than an empty one. `oauth` needs none. Every database published today is
 * licensed, so a keyless `database` call is answered `401` for now; it exists
 * because what the API serves without a license is a product decision, not the
 * client's to refuse.
 */
export class InternetData {
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
        const client = createClient(createConfig({
            baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
            ...(options.apiKey === undefined ? {} : { auth: bearerOnly(options.apiKey) }),
            fetch: fetchImpl,
        }));
        const retries = options.retries ?? 2;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.database = new DatabaseApi(client, retries, timeoutMs, fetchImpl);
        this.oauth = new OauthApi(client, retries, timeoutMs);
    }
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
            return unwrap<ListDatabasesResponses[200]>(res).databases;
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
            return unwrap<DatabaseMetadataV2Responses[200]>(res);
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
            return unwrap<DatabaseChecksumV2Responses[200]>(res).checksums;
        });
    }

    /**
     * Your organization's recent download attempts, newest first.
     *
     * Refusals are listed too: a denial is what answers "it stopped working",
     * and its absence answers nothing.
     */
    async downloads(options: DownloadsOptions = {}): Promise<Download[]> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        return withRetry(this.retries, async () => {
            const res = await deadline(timeoutMs, (signal) => listDownloads({
                client: this.client,
                ...(options.limit === undefined ? {} : { query: { limit: options.limit } }),
                signal: signal,
            }));
            return unwrap<ListDownloadsResponses[200]>(res).downloads;
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
    async downloadUrl(id: string, format: DatabaseFormat): Promise<string> {
        assertFormat(format);
        return withRetry(this.retries, async () => {
            const res = await deadline(this.timeoutMs, (signal) => downloadRedirect({
                client: this.client,
                query: { id: id, format: format },
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
    ): Promise<number> {
        const res = await this.fetchDatabaseFile(id, format);
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
    async downloadBytes(id: string, format: DatabaseFormat): Promise<Uint8Array> {
        const res = await this.fetchDatabaseFile(id, format);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Follows the 302 as a SECOND, unauthenticated request: the presigned URL
    // carries its own authorization, so forwarding the API key would hand a
    // credential to a host that has no business holding it.
    private async fetchDatabaseFile(id: string, format: DatabaseFormat): Promise<Response> {
        const url = await this.downloadUrl(id, format);
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
