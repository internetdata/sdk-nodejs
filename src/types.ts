import type {
    Database, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums, Download,
} from './generated/types.gen.js';

export type {
    Database, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums, Download,
};

/** A file format one version of a database is built in. */
export type DatabaseFormat = DatabaseVersion['formats'][number];

/**
 * @deprecated Use {@link DatabaseFormat}. Kept so existing imports keep
 * compiling; this brand's Java, .NET and Swift SDKs have always called it
 * `DatabaseFormat`, and so does every VPNDetection SDK.
 */
export type DatasetFormat = DatabaseFormat;

/** Where your organization's licence for a database family stands today. */
export type Standing = Database['standing'];

/** What a licence permits you to do with the data. Absent when there is no licence. */
export type LicenseType = NonNullable<Database['license_type']>;

// The runtime halves of the three closed vocabularies above, for a caller that
// wants to validate or enumerate rather than switch. Each is TYPED by the
// generated union, so a value the spec does not define will not compile; that a
// value is MISSING is what the shared conformance corpus pins.
export const DATABASE_FORMATS: readonly DatabaseFormat[] = ['csvgz', 'mmdb'];

/** @deprecated Use {@link DATABASE_FORMATS}. */
export const DATASET_FORMATS: readonly DatabaseFormat[] = DATABASE_FORMATS;
export const STANDINGS: readonly Standing[] = ['licensed', 'expired', 'unlicensed'];
export const LICENSE_TYPES: readonly LicenseType[] = [
    'evaluation', 'standard', 'redistribute',
];
