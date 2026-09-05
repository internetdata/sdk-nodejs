import { defineConfig } from '@hey-api/openapi-ts';

// Generates from the PINNED spec in this repo, never from a URL, so a build is
// reproducible and offline and the diff shows which spec version produced it.
// Refresh with scripts/download-spec.sh.
//
// The spec also carries the v1 endpoints, and they are generated. Nothing here
// wraps them and nothing exports them: v1 is a separate credential vocabulary
// (`?apikey=` rather than a bearer key) kept alive for customers whose clients
// cannot follow a redirect, and putting two ways to ask the same question in
// front of a reader of this package would be a disservice to both. Dropping
// them at generation time is not available - 0.99.0 declares `input.filters`
// and `input.patch` and implements neither.
export default defineConfig({
    input: './spec/openapi.yaml',
    output: {
        path: './src/generated',
    },
    plugins: ['@hey-api/client-fetch'],
});
