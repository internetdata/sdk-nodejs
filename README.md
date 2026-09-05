# [<img src="https://docs.internetdata.io/logo.svg" alt="InternetData" width="24"/>](https://internetdata.io/) InternetData Node.js Client Library

[![npm](https://img.shields.io/npm/v/@internetdata/internetdata.svg)](https://www.npmjs.com/package/@internetdata/internetdata)
[![license](https://img.shields.io/npm/l/@internetdata/internetdata.svg)](LICENSE)

The official Node.js client library for the [InternetData](https://internetdata.io) API.

InternetData publishes IP databases: VPN and proxy address space, hosting and CDN ranges, provider catalogs, bogons and more, as gzipped CSV and as MMDB. This library lists the databases your organization is licensed for, tells you what is inside one before you fetch it, downloads it, and verifies the bytes you got.

## Getting Started

```bash
npm install @internetdata/internetdata
```

Requires Node.js 22 or newer. TypeScript types are included.

## Usage

Every call needs an API key carrying the `db.download` scope. Databases are licensed by contract rather than bought self-serve, so a key arrives with the licence; see the [API documentation](https://docs.internetdata.io/api) or write to [dev@internetdata.io](mailto:dev@internetdata.io).

```js
import { InternetData } from '@internetdata/internetdata';

const client = new InternetData({ apiKey: process.env.INTERNETDATA_API_KEY });

for (const db of await client.database.list()) {
    console.log(db.base, db.standing, db.versions.map((v) => v.id).join(', '));
}
```

`list()` returns one entry per database FAMILY, because a licence is held against the family while a download names a specific version. `standing` is `licensed` if the family is yours today, `expired` if the term has ended, and `unlicensed` if it is published but has never been bought. `versions` carries the ids you pass everywhere else, oldest first, and the formats each one is actually built in.

**This listing is not the same for every key.** A database commissioned for a single customer is absent from the catalog for every other organization, rather than being listed as unlicensed. So the listing is only ever an answer about the key that asked, this library never caches one, and you should not carry an answer from one key over to another or treat it as the published catalog.

### What is inside a database

```js
const meta = await client.database.metadata('vpn_ip_v1');

console.log(meta.updated);        // '2026-09-04', the day this build was generated
console.log(meta.entries);        // rows in the build
console.log(meta.size.csvgz);     // bytes you are about to move
console.log(meta.schema.csvgz);   // [{ name, type, description }, ...]
console.log(meta.sample?.mmdb);   // a few real rows
```

Poll `updated` and `entries` to decide whether today's build is worth fetching; both are free of the transfer. `size` is also the honest way to budget a download before starting one.

### Downloading

`download` streams a file to a path and returns the number of bytes written. Nothing larger than a chunk is ever held in memory, whatever the database weighs:

```js
const written = await client.database.download('vpn_ip_v1', 'mmdb', './vpn_ip_v1.mmdb');
console.log(`${written} bytes`);
```

The bytes go to a neighbouring `.part` file and the name only appears once the transfer completes, so an interruption cannot leave a truncated file that reads as a whole database. You can pass a writable stream instead of a path, in which case it stays yours to close and gets no such treatment.

Or take the link and run the transfer yourself. The API answers a redirect to time-limited object storage, and that URL authorizes itself, so it can be handed to something holding no API key:

```js
const url = await client.database.downloadUrl('vpn_ip_v1', 'mmdb');
```

Or, for a small database, take the bytes directly:

```js
const bytes = await client.database.downloadBytes('bogon_ip_v1', 'csvgz');
```

`downloadBytes` holds the whole file in memory and the catalog spans seven orders of magnitude, from a few hundred bytes to over 5 GiB, so use `download` for anything you have not checked with `metadata` first.

### Verifying what you got

```js
const sums = await client.database.checksums('vpn_ip_v1', 'mmdb');
console.log(sums.sha256);   // also md5, sha1, sha512
```

### Download history

Your organization's recent attempts, newest first, refusals included, because a denial is what answers "it stopped working" and its absence answers nothing:

```js
for (const d of await client.database.downloads({ limit: 20 })) {
    console.log(d.created, d.dataset_id, d.format, d.outcome, d.http_status);
}
```

### Errors

Failures throw an `InternetDataError` carrying a `kind` and a `retryable` flag:

```js
import { InternetDataError } from '@internetdata/internetdata';

try {
    await client.database.download('vpn_ip_v1', 'mmdb', './vpn_ip_v1.mmdb');
} catch (err) {
    if (err instanceof InternetDataError) {
        console.error(err.kind, err.status, err.retryable);
    }
}
```

`kind` is one of `bad_request`, `unauthorized`, `forbidden`, `rate_limited`, `quota_exceeded`, `server_error` or `network`. The message is the API's own result code, such as `NOT_LICENSED` or `LICENSE_EXPIRED`, which is usually the specific thing you want to read.

Note that `rate_limited` and `quota_exceeded` both arrive as HTTP 429 and are not the same thing. A rate limit is the API facing a burst, so retrying later works; a spent quota needs your allowance raised or the window to roll over. The library retries the first for you and never the second.

A failure part way through a transfer is rethrown as it arrived rather than wrapped: a reset socket and a full disk are different problems, and only one of them is ours.

## Other Libraries

There are official InternetData client libraries available for many languages including PHP, Python, Go, Java, Ruby, and many popular frameworks such as Django, Rails, and Laravel. See our GitHub at https://github.com/internetdata for more.

## About InternetData

IP intelligence databases: VPN, proxy, hosting, CDN and relay address space, provider catalogs and network metadata, published as CSV and MMDB.

[<img src="https://docs.internetdata.io/logo.svg" alt="InternetData" width="96"/>](https://internetdata.io/)

## License

This project is licensed under the [MIT License](LICENSE).
