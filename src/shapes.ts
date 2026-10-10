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

function isObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function every(value: unknown, valid: (entry: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every(valid);
}

function isDatabase(entry: unknown): boolean {
    return hasMembers(entry, DATABASE_MEMBERS)
        && every(entry['versions'], (version) => hasMembers(version, DATABASE_VERSION_MEMBERS)
            && Array.isArray(version['formats']));
}

export function isDatabaseList(data: unknown): boolean {
    return hasMembers(data, ['databases']) && every(data['databases'], isDatabase);
}

export function isDatabaseMetadata(data: unknown): boolean {
    return hasMembers(data, DATABASE_METADATA_MEMBERS) && typeof data['id'] === 'string'
        && typeof data['entries'] === 'number' && isObject(data['schema']) && isObject(data['size']);
}

export function isChecksumsResponse(data: unknown): boolean {
    return hasMembers(data, ['checksums']) && hasMembers(data['checksums'], DB_CHECKSUMS_MEMBERS);
}

export function isDownloadList(data: unknown): boolean {
    return hasMembers(data, ['downloads']) && every(data['downloads'], (entry) => hasMembers(entry, DOWNLOAD_MEMBERS));
}
