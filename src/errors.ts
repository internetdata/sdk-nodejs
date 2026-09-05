/**
 * Why a request failed.
 *
 * `rate_limited` and `quota_exceeded` both arrive as HTTP 429 and are NOT the
 * same thing. A rate limit is the API protecting itself and carries
 * `Retry-After`; retrying works. A spent quota carries no such header and
 * retrying will not help until the window rolls over or the limit is raised.
 * The header is the only thing that distinguishes them.
 */
export type ErrorKind =
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'rate_limited'
    | 'quota_exceeded'
    | 'server_error'
    | 'network';

export class InternetDataError extends Error {
    readonly kind: ErrorKind;
    readonly status?: number;
    readonly retryAfterSeconds?: number;

    constructor(kind: ErrorKind, message: string, status?: number, retryAfterSeconds?: number) {
        super(message);
        this.name = 'InternetDataError';
        this.kind = kind;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    /** Whether retrying this exact request could succeed. */
    get retryable(): boolean {
        return this.kind === 'rate_limited' || this.kind === 'server_error' || this.kind === 'network';
    }
}

export function errorFromResponse(
    status: number, headers: { get(name: string): string | null }, message?: string,
): InternetDataError {
    const text = message ?? `request failed with status ${status}`;
    const retryAfter = parseRetryAfter(headers.get('retry-after'));

    if (status === 429) {
        // Present means transient, absent means an allowance is spent. Nothing
        // else in the response separates the two.
        return retryAfter === undefined
            ? new InternetDataError('quota_exceeded', text, status)
            : new InternetDataError('rate_limited', text, status, retryAfter);
    }
    if (status === 400) {
        return new InternetDataError('bad_request', text, status);
    }
    if (status === 401) {
        return new InternetDataError('unauthorized', text, status);
    }
    if (status === 403) {
        return new InternetDataError('forbidden', text, status);
    }
    // Any other 4xx is a CLIENT error. Falling through to the server_error
    // default would make it retryable, so a misspelled dataset id (404
    // UNKNOWN_DATASET) would be retried twice before failing. Only 5xx and
    // transport failures are worth a retry.
    if (status < 500) {
        return new InternetDataError('bad_request', text, status);
    }
    return new InternetDataError('server_error', text, status);
}

/**
 * The `rc` an error envelope carries.
 *
 * Deliberately not an enum, in the spec or here: a code added later must stay
 * readable to a client generated today, and the string IS the message a caller
 * wants to see.
 */
export function messageFromBody(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) {
        return undefined;
    }
    const rc = (body as Record<string, unknown>)['rc'];
    return typeof rc === 'string' ? rc : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds;
    }
    // The header also permits an HTTP date.
    const when = Date.parse(value);
    if (Number.isNaN(when)) {
        return undefined;
    }
    return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}
