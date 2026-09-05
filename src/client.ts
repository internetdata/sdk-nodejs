import pRetry from 'p-retry';

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

import { errorFromResponse, InternetDataError, messageFromBody } from './errors.js';
import type {
    Database, DatabaseMetadata, DatasetFormat, DbChecksums, Download,
} from './types.js';

/**
 * Where `download` puts the bytes: a path to write, or a stream you opened
 * yourself and will close yourself.
 */
export type DownloadDestination = string | Writable;

export const DEFAULT_BASE_URL = 'https://internetdata.io';

export interface DownloadsOptions {
    /** How many attempts to return, newest first. The API clamps this to 200. */
    limit?: number;
}

export interface Options {
    /**
     * Your API key, carrying the `db.download` scope. Omit it to send no
     * `Authorization` header at all, which is what a dataset offered without a
     * licence would be read with.
     */
    apiKey?: string;
    baseUrl?: string;
    /** Retry attempts for a transient failure. Default 2. */
    retries?: number;
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
 * than an empty one. Every endpoint published today is licensed, so a keyless
 * client is answered `401` for now; it exists because what the API serves
 * without a licence is a product decision, not the client's to refuse.
 */
export class InternetData {
    /** The database catalog, downloads and their history. */
    readonly database: DatabaseApi;

    constructor(options: Options = {}) {
        // Resolved once, because the download path calls object storage
        // directly rather than through the generated client and has to reach
        // the same implementation a test substituted.
        const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        const client = createClient(createConfig({
            baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
            ...(options.apiKey === undefined ? {} : { auth: () => options.apiKey }),
            fetch: fetchImpl,
        }));
        this.database = new DatabaseApi(client, options.retries ?? 2, fetchImpl);
    }
}

/** The licensed database downloads. Access is granted by contract, not self-serve. */
export class DatabaseApi {
    constructor(
        private readonly client: Client,
        private readonly retries: number,
        private readonly fetchImpl: typeof globalThis.fetch,
    ) {}

    /**
     * The published catalog as your organization may see it, one entry per
     * database FAMILY, with `standing` saying where your licence stands.
     *
     * **This listing is not the same for everyone, and it is not cached.** A
     * database commissioned for a single customer is absent for every other
     * organization rather than listed as unlicensed, so the answer is only ever
     * the one this key's organization is entitled to see. Ask again rather than
     * holding on to it, and never carry one key's answer over to another.
     */
    async list(): Promise<Database[]> {
        return withRetry(this.retries, async () => {
            const res = await listDatabases({ client: this.client });
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
            const res = await databaseMetadataV2({ client: this.client, query: { id: id } });
            return unwrap<DatabaseMetadataV2Responses[200]>(res);
        });
    }

    /**
     * The digests for one database file.
     *
     * Returns the whole set rather than one algorithm: which digests a database
     * publishes is the API's choice, not ours.
     */
    async checksums(id: string, format: DatasetFormat): Promise<DbChecksums> {
        return withRetry(this.retries, async () => {
            const res = await databaseChecksumV2({
                client: this.client, query: { id: id, format: format },
            });
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
        return withRetry(this.retries, async () => {
            const res = await listDownloads({
                client: this.client,
                ...(options.limit === undefined ? {} : { query: { limit: options.limit } }),
            });
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
    async downloadUrl(id: string, format: DatasetFormat): Promise<string> {
        return withRetry(this.retries, async () => {
            const res = await downloadRedirect({
                client: this.client,
                query: { id: id, format: format },
                redirect: 'manual',
            });
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
        id: string, format: DatasetFormat, destination: DownloadDestination,
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
    async downloadBytes(id: string, format: DatasetFormat): Promise<Uint8Array> {
        const res = await this.fetchDatabaseFile(id, format);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Follows the 302 as a SECOND, unauthenticated request: the presigned URL
    // carries its own authorization, so forwarding the API key would hand a
    // credential to a host that has no business holding it.
    private async fetchDatabaseFile(id: string, format: DatasetFormat): Promise<Response> {
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

// The generated client puts a non-2xx body on `error` rather than `data`, and
// types `response` as optional because a transport failure produces neither.
interface Res { data?: unknown, error?: unknown, response?: Response }

function unwrap<T>(res: Res): T {
    if (res.response === undefined) {
        throw new InternetDataError('network', 'no response from the API');
    }
    if (!res.response.ok) {
        throw errorFromResponse(
            res.response.status, res.response.headers, messageFromBody(res.error ?? res.data),
        );
    }
    return res.data as T;
}

// p-retry owns the backoff schedule; the extra sleep here is what honors a
// server-supplied Retry-After, which p-retry has no way to know about. A 429
// carrying that header is the only 429 worth retrying, which is why the wait
// and the retry decision both key off the same field.
async function withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
    try {
        return await pRetry(fn, {
            retries: retries,
            shouldRetry: ({ error }) => !(error instanceof InternetDataError) || error.retryable,
            onFailedAttempt: async ({ error }) => {
                const seconds = error instanceof InternetDataError
                    ? error.retryAfterSeconds
                    : undefined;
                if (seconds !== undefined && seconds > 0) {
                    await new Promise((r) => setTimeout(r, seconds * 1000));
                }
            },
        });
    } catch (err) {
        throw asError(err);
    }
}

function asError(err: unknown): InternetDataError {
    if (err instanceof InternetDataError) {
        return err;
    }
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof InternetDataError) {
        return cause;
    }
    return new InternetDataError('network', err instanceof Error ? err.message : String(err));
}
