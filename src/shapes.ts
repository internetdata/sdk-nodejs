// The members each database answer must carry before the client hands it back:
// every one the spec requires and never sends as null, the rule go 2.6.1 holds
// to and checked against the real API. The test reads them against the
// generated types, so a member the spec adds fails the suite until it is here.

import { hasMembers } from './transport.js';

export const DATABASE_MEMBERS = ['base', 'name', 'summary', 'standing', 'open', 'versions'] as const;
export const DATABASE_VERSION_MEMBERS = ['id', 'version', 'summary', 'formats'] as const;
export const DATABASE_METADATA_MEMBERS = ['id', 'updated', 'entries', 'schema', 'size'] as const;
export const DB_CHECKSUMS_MEMBERS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
// `checksums` hands back the digests alone, so through 2.7.3 nothing read `id` or
// `format`, and an answer without either came back as whole (measured 2026-10-23).
export const CHECKSUM_ANSWER_MEMBERS = ['id', 'format', 'checksums'] as const;
export const DOWNLOAD_MEMBERS = ['dataset_id', 'format', 'outcome', 'sample', 'open', 'created'] as const;

// Every member's type, the nullable and optional ones included. Through 2.5.4
// only presence was checked, so a version served as "3" came back as that
// string where a number is promised (read 2026-10-16). A member the spec
// requires and never sends as null may not be null; any other may be null or
// absent, and is otherwise of its type.
//
// A `date` or `date-time` member is RFC 3339's, on a day that exists. Through
// 2.7.4 one was checked as a string alone, so `x`, `tomorrow`, 30 February, 24:00,
// a time with no offset, `+0500` and a date alone where a date-time is due all came
// back as served (measured 2026-10-28). The test holds these kinds to the spec's
// `format`.
type Kind = 'string' | 'integer' | 'boolean' | 'object' | 'array' | 'date' | 'date-time';

export const DATABASE_TYPES: Record<string, Kind> = {
    base: 'string', name: 'string', summary: 'string', standing: 'string', open: 'boolean',
    license_type: 'string', starts: 'date-time', expires: 'date-time', renews_at: 'date-time', notice_due_at: 'date-time',
    versions: 'array',
};
export const DATABASE_VERSION_TYPES: Record<string, Kind> = {
    id: 'string', version: 'integer', summary: 'string', formats: 'array', sample_formats: 'array',
};
export const DATABASE_METADATA_TYPES: Record<string, Kind> = {
    id: 'string', update_freq: 'string', updated: 'date', entries: 'integer', schema: 'object',
    sample: 'object', size: 'object', sample_size: 'object', sample_entries: 'integer',
};
export const COLUMN_TYPES: Record<string, Kind> = { name: 'string', type: 'string', description: 'string' };
export const DOWNLOAD_TYPES: Record<string, Kind> = {
    dataset_id: 'string', format: 'string', outcome: 'string', sample: 'boolean', open: 'boolean',
    bytes: 'integer', http_status: 'integer', apikey_id: 'string', client_ip: 'string', user_agent: 'string',
    created: 'date-time',
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown, kind: Kind): boolean {
    switch (kind) {
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'boolean': return typeof value === 'boolean';
        case 'object': return isObject(value);
        case 'array': return Array.isArray(value);
        case 'date': return typeof value === 'string' && isFullDate(value);
        case 'date-time': return typeof value === 'string' && isDateTime(value);
    }
}

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339's `full-date`, naming a day its month has. */
function isFullDate(value: string): boolean {
    const m = FULL_DATE.exec(value);
    return m !== null && isDay(m[1]!, m[2]!, m[3]!);
}

/**
 * RFC 3339's `date-time`, its lowercase `t` and `z` included, with an hour below 24,
 * a minute and a second below 60 and an offset of at most 23:59.
 */
function isDateTime(value: string): boolean {
    const m = DATE_TIME.exec(value);
    return m !== null && isDay(m[1]!, m[2]!, m[3]!) && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60
        && (m[7] === undefined || (Number(m[7]) < 24 && Number(m[8]) < 60));
}

// setUTCFullYear rather than Date.UTC, which reads a year below 100 as 19xx.
function isDay(year: string, month: string, day: string): boolean {
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
        && date.getUTCDate() === Number(day);
}

function typed(value: unknown, required: readonly string[], types: Record<string, Kind>): value is Record<string, unknown> {
    return hasMembers(value, required) && Object.entries(types).every(([member, kind]) => {
        const v = value[member];
        return v === undefined || v === null ? !required.includes(member) : isKind(v, kind);
    });
}

function every(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every(valid);
}

function isString(value: unknown): boolean {
    return typeof value === 'string';
}

function values(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return isObject(value) && Object.values(value).every(valid);
}

function isVersion(version: unknown): boolean {
    return typed(version, DATABASE_VERSION_MEMBERS, DATABASE_VERSION_TYPES)
        && every(version['formats'], isString)
        && (version['sample_formats'] == null || every(version['sample_formats'], isString));
}

function isDatabase(entry: unknown): boolean {
    return typed(entry, DATABASE_MEMBERS, DATABASE_TYPES) && every(entry['versions'], isVersion);
}

export function isDatabaseList(data: unknown): boolean {
    return hasMembers(data, ['databases']) && every(data['databases'], isDatabase);
}

export function isDatabaseMetadata(data: unknown): boolean {
    return typed(data, DATABASE_METADATA_MEMBERS, DATABASE_METADATA_TYPES)
        && values(data['schema'], (columns) => every(columns, (c) => typed(c, ['name', 'type'], COLUMN_TYPES)))
        && values(data['size'], Number.isInteger)
        && (data['sample'] == null || values(data['sample'], (rows) => every(rows, isObject)))
        && (data['sample_size'] == null || values(data['sample_size'], Number.isInteger));
}

export function isChecksumsResponse(data: unknown): boolean {
    return typed(data, CHECKSUM_ANSWER_MEMBERS, { id: 'string', format: 'string', checksums: 'object' })
        && typed(data['checksums'], DB_CHECKSUMS_MEMBERS, { md5: 'string', sha1: 'string', sha256: 'string', sha512: 'string' });
}

export function isDownloadList(data: unknown): boolean {
    return hasMembers(data, ['downloads']) && every(data['downloads'], (entry) => typed(entry, DOWNLOAD_MEMBERS, DOWNLOAD_TYPES));
}
