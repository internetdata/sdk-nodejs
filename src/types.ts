import type {
    Database, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums, Download,
} from './generated/types.gen.js';

export type {
    Database, DatabaseMetadata, DatabaseMetadataColumn, DatabaseVersion, DbChecksums, Download,
};

/** A file format one version of a database is built in. */
export type DatasetFormat = DatabaseVersion['formats'][number];

/** Where your organization's licence for a database family stands today. */
export type Standing = Database['standing'];

/** What a licence permits you to do with the data. Absent when there is no licence. */
export type Redistribution = NonNullable<Database['redistribution']>;

// The runtime halves of the three closed vocabularies above, for a caller that
// wants to validate or enumerate rather than switch. Each is TYPED by the
// generated union, so a value the spec does not define will not compile; that a
// value is MISSING is what the shared conformance corpus pins.
export const DATASET_FORMATS: readonly DatasetFormat[] = ['csvgz', 'mmdb'];
export const STANDINGS: readonly Standing[] = ['licensed', 'expired', 'unlicensed'];
export const REDISTRIBUTION_RIGHTS: readonly Redistribution[] = [
    'evaluation', 'internal', 'redistribute',
];
