// The members each database answer must carry before the client hands it back:
// every one the spec requires and never sends as null, the rule go 2.6.1 holds
// to and checked against the real API. The test reads them against the
// generated types, so a member the spec adds fails the suite until it is here.

import { hasMembers } from './transport.js';

export const DATABASE_MEMBERS = ['base', 'name', 'summary', 'standing', 'open', 'versions'] as const;
export const DATABASE_VERSION_MEMBERS = ['id', 'version', 'summary', 'formats'] as const;
export const DATABASE_METADATA_MEMBERS = ['id', 'updated', 'entries', 'schema', 'size'] as const;
export const DB_CHECKSUMS_MEMBERS = ['md5', 'sha1', 'sha256', 'sha512'] as const;
export const DOWNLOAD_MEMBERS = ['dataset_id', 'format', 'outcome', 'sample', 'open', 'created'] as const;

// Every member's type, the nullable and optional ones included. Through 2.5.4
// only presence was checked, so a version served as "3" came back as that
// string where a number is promised (read 2026-10-16). A member the spec
// requires and never sends as null may not be null; any other may be null or
// absent, and is otherwise of its type.
type Kind = 'string' | 'integer' | 'boolean' | 'object' | 'array';

const DATABASE_TYPES: Record<string, Kind> = {
    base: 'string', name: 'string', summary: 'string', standing: 'string', open: 'boolean',
    license_type: 'string', starts: 'string', expires: 'string', renews_at: 'string', notice_due_at: 'string',
    versions: 'array',
};
const DATABASE_VERSION_TYPES: Record<string, Kind> = {
    id: 'string', version: 'integer', summary: 'string', formats: 'array', sample_formats: 'array',
};
const DATABASE_METADATA_TYPES: Record<string, Kind> = {
    id: 'string', update_freq: 'string', updated: 'string', entries: 'integer', schema: 'object',
    sample: 'object', size: 'object', sample_size: 'object', sample_entries: 'integer',
};
const COLUMN_TYPES: Record<string, Kind> = { name: 'string', type: 'string', description: 'string' };
// The client's address is left unchecked: its wire name ends `_ip`, which the
// conformance guard against a compiled-in catalog reads as a database id.
const DOWNLOAD_TYPES: Record<string, Kind> = {
    dataset_id: 'string', format: 'string', outcome: 'string', sample: 'boolean', open: 'boolean',
    bytes: 'integer', http_status: 'integer', apikey_id: 'string', user_agent: 'string', created: 'string',
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
    }
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
        && (data['sample_size'] == null || values(data['sample_size'], Number.isInteger));
}

export function isChecksumsResponse(data: unknown): boolean {
    return hasMembers(data, ['checksums'])
        && typed(data['checksums'], DB_CHECKSUMS_MEMBERS, { md5: 'string', sha1: 'string', sha256: 'string', sha512: 'string' });
}

export function isDownloadList(data: unknown): boolean {
    return hasMembers(data, ['downloads']) && every(data['downloads'], (entry) => typed(entry, DOWNLOAD_MEMBERS, DOWNLOAD_TYPES));
}
