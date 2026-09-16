import type {
    Database, DatabaseFormat, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion,
    DbChecksums, Download, Standing,
} from './generated/types.gen.js';

export type {
    Database, DatabaseFormat, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion,
    DbChecksums, Download, Standing,
};

/** What a license permits you to do with the data. `null` when there is none. */
export type LicenseType = Database['license_type'];

/**
 * @deprecated Use {@link DatabaseFormat}. Kept so existing imports keep
 * compiling; this brand's Java, .NET and Swift SDKs have always called it
 * `DatabaseFormat`, and so does every VPNDetection SDK.
 */
export type DatasetFormat = DatabaseFormat;

// The runtime halves of the three closed vocabularies above, for a caller that
// wants to validate or enumerate rather than switch. Each is TYPED by the
// generated union, so a value the spec does not define will not compile; that a
// value is MISSING is what the shared conformance corpus pins.
export const DATABASE_FORMATS: readonly DatabaseFormat[] = ['csvgz', 'mmdb'];

/** @deprecated Use {@link DATABASE_FORMATS}. */
export const DATASET_FORMATS: readonly DatabaseFormat[] = DATABASE_FORMATS;
export const STANDINGS: readonly Standing[] = ['licensed', 'expired', 'unlicensed'];
export const LICENSE_TYPES: readonly NonNullable<LicenseType>[] = [
    'evaluation', 'standard', 'redistribute',
];
