# [<img src="https://s3.internetdata.io/internetdata-public/brand/mark.svg" alt="InternetData" height="28"/>](https://internetdata.io/) InternetData Node.js Client Library

[![npm](https://img.shields.io/npm/v/@internetdata/internetdata.svg)](https://www.npmjs.com/package/@internetdata/internetdata)
[![license](https://img.shields.io/npm/l/@internetdata/internetdata.svg)](LICENSE)

The official Node.js client library for the [InternetData](https://internetdata.io) API.

It looks up what every InternetData database says about an IP address, an AS or a domain, and downloads the databases your organization is licensed for.

## Getting Started

```bash
npm install @internetdata/internetdata
```

Requires Node.js 22 or newer. TypeScript types are included.

## Usage

**No API key needed to start.** Unlimited, the free plan, answers Tor, relay, anycast, carrier, satellite and the five service flags (SSH, SMTP, web, DNS resolver and BitTorrent), reverse DNS, country-level `location`, `asn`, the company's name and domain and the abuse email, with no daily or monthly cap, with a key or without one.

```js
import { InternetData } from '@internetdata/internetdata';

const client = new InternetData();

const result = await client.lookup('146.70.116.130');
console.log(result.isTor);              // false
console.log(result.location.country);   // the ISO 3166 country code
console.log(result.company.name);       // who the address belongs to
```

### With an API key

Every paid plan answers every field: `is_vpn`, `is_hosting`, `is_cdn` and the four proxy flags as well, city-level location, the whois records and the detail behind each flag. The plans differ only in how many lookups they include, and a free account tries every field, 100 lookups a day. Create a key in the [console](https://app.internetdata.io), then pass it in:

```js
const client = new InternetData({ apiKey: process.env.INTERNETDATA_API_KEY });

const result = await client.lookup('146.70.116.130');
console.log(result.isVpn);           // on a paid plan
console.log(result.vpn?.provider);   // on a paid plan
console.log(result.location.city);   // on a paid plan
```

### An AS or a domain

```js
const asn = await client.lookupAsn(9009);
console.log(asn.name);           // M247 Europe SRL
console.log(asn.prefixes);       // on a paid plan

const domain = await client.lookupDomain('example.com');
console.log(domain.isRegistered);   // true
console.log(domain.dns?.mx);        // on a paid plan
```

Unlimited answers an AS's registration, and whether a domain is registered and which record types it has. A paid plan adds the AS's whois record and prefixes, and the domain's records, IP ranges and whether it is disposable. Neither lookup is cached or batched, and `lookup` refuses an AS or a domain before sending it.

### Your own address

```js
const result = await client.myIp();
console.log(result.ip);   // the address we saw this call come from
```

### Your plan and usage

```js
const ent = await client.myEntitlement();
console.log(ent.plan.key);          // starter
console.log(ent.usage.requests);    // 580
console.log(ent.usage.window_end);  // when the allowance resets
```

Usage counts against the anniversary of your subscription on a paid plan, not the calendar month and not the billing period, and against the UTC day on the free plan; it is the same number a lookup is gated on. `hard_limit` is null on an uncapped plan, which is not the same as zero.

### Batch lookup

Look up as many addresses as you like in one call. Bogons and cached answers are handled locally, and the rest go to the batch endpoint in chunks of up to 1000, in parallel. The batch endpoint needs a paid plan:

```js
const results = await client.lookupBatch(['146.70.116.130', '8.8.8.8', '1.1.1.1']);

for (const [ip, result] of results) {
    if (result instanceof Error) {
        console.log(`${ip}: ${result.message}`);
        continue;
    }
    console.log(`${ip}: ${result.isVpn}`);
}
```

Results are keyed by address, in the order you first listed each one, so duplicates in your list collapse into a single entry and one address failing never loses the rest: it carries its error as its value, with the status the API would have given that address on its own.

How many chunks are in flight at once, how many times a failed chunk is retried, and how long each request may take are configurable per call:

```js
const results = await client.lookupBatch(manyIps, { concurrency: 4, retries: 4, timeoutMs: 10_000 });
```

### Caching

Answers are cached by default, so repeat lookups of the same address are free:

```js
const client = new InternetData();

const result = await client.lookup('146.70.116.130');
console.log(result.isTor);   // false, API request

const result2 = await client.lookup('146.70.116.130');
console.log(result2.isTor);  // false, no API request, result was cached
```

You can change the default cache variables (max size, TTL, etc) on initialization, or even disable it:

```js
const client = new InternetData({ cache: { max: 50_000, ttlMs: 6 * 60 * 60 * 1000 } });
const clientNoCache = new InternetData({ cache: false });
```

### Private and reserved addresses

Private, loopback, link-local, documentation and multicast addresses (and their IPv6 equivalents, including the 6to4 and Teredo ranges) are answered locally, so they cost no request and no quota. Each gets the answer the API gives one, every flag false bar `is_bogon` and every other field empty:

```js
const result = await client.lookup('192.168.1.1');
result.isBogon;   // true
result.isVpn;     // false
```

The check is available on the client, which is handy when your inputs are addresses anyway:

```js
client.isBogon('10.0.0.1');    // true
client.isBogon('8.8.8.8');     // false
```

It is also importable on its own, if you want it without a client:

```js
import { isBogon } from '@internetdata/internetdata';

isBogon('10.0.0.1');    // true
```

### Errors

Failures throw an `InternetDataError` carrying a `kind` and a `retryable` flag:

```js
import { InternetDataError } from '@internetdata/internetdata';

try {
    await client.lookup('146.70.116.130');
} catch (err) {
    if (err instanceof InternetDataError) {
        console.error(err.kind, err.status, err.retryable);
    }
}
```

`kind` is one of `bad_request`, `unauthorized`, `forbidden`, `rate_limited`, `quota_exceeded`, `server_error` or `network`. The message is the API's own: a sentence from a lookup, and from a database call its result code, such as `NOT_LICENSED` or `LICENSE_EXPIRED`.

`rate_limited` is a 429 that carries `Retry-After`, and the library retries it for you. `quota_exceeded` is a 429 without one, which it never retries: your allowance needs raising, or its window has to roll over. The database calls have no quota, so only a lookup answers `quota_exceeded`.

A failure part way through a transfer is rethrown as it arrived rather than wrapped: a reset socket and a full disk are different problems, and only one of them is ours.

### Timeouts

A request that hasn't finished after 30 seconds is abandoned and surfaces as a retryable `network` error. The limit applies to each attempt, so a call that gets retried can take longer in total. Set it for the client, or for a single lookup:

```js
const client = new InternetData({ timeoutMs: 10_000 });

const result = await client.lookup('146.70.116.130', { timeoutMs: 2000 });
```

A database transfer is exempt, because a large one takes minutes.

### Database downloads

Every database call needs an API key carrying the `db.download` scope; create one in the [console](https://app.internetdata.io). The Open databases are licensed to every organization from the start and are free under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and `list()` marks them `open`. The rest are licensed by contract rather than bought self-serve; see the [API documentation](https://docs.internetdata.io/api), or [request an evaluation](https://internetdata.io/contact?purpose=evaluation&subject=Evaluation+license) if your organization doesn't have a license yet.

```js
import { InternetData } from '@internetdata/internetdata';

const client = new InternetData({ apiKey: process.env.INTERNETDATA_API_KEY });

for (const db of await client.database.list()) {
    console.log(db.base, db.standing, db.versions.map((v) => v.id).join(', '));
}
```

`list()` returns one entry per database FAMILY, because a license is held against the family while a download names a specific version. `standing` is `licensed` if the family is yours today, `expired` if the term has ended, and `unlicensed` if it is published but has never been bought. `versions` carries the IDs you pass everywhere else, oldest first, and the formats each one is actually built in.

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

The bytes go to a neighboring `.part` file and the name only appears once the transfer completes, so an interruption cannot leave a truncated file that reads as a whole database. You can pass a writable stream instead of a path, in which case it stays yours to close and gets no such treatment.

Or take the link and run the transfer yourself. The API answers a redirect to time-limited object storage, and that URL authorizes itself, so it can be handed to something holding no API key:

```js
const url = await client.database.downloadUrl('vpn_ip_v1', 'mmdb');
```

Or, for a small database, take the bytes directly:

```js
const bytes = await client.database.downloadBytes('bogon_ip_v1', 'csvgz');
```

Each of the three downloads the build that is live unless you name one. A `database.updated` webhook names the build it announces and carries its `sha256`, so a receiver that downloads after the next publish asks for that build to get the file the hash is of:

```js
await client.database.download('vpn_ip_v1', 'mmdb', './vpn_ip_v1.mmdb', { build: event.data.build });
```

A build is kept 7 days. Past that the call fails as `bad_request` with the message `BUILD_GONE`, and downloading without `build` fetches the live one.

The formats are `csvgz` and `mmdb`. They're exported as `DATABASE_FORMATS`, beside `STANDINGS` and `LICENSE_TYPES`, for code that takes one from a command line or a config file. Anything else is refused before a request goes out, as a `bad_request` naming the formats that exist:

```js
import { DATABASE_FORMATS } from '@internetdata/internetdata';

if (!DATABASE_FORMATS.includes(format)) {
    console.error(`--format must be one of ${DATABASE_FORMATS.join(', ')}`);
}
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

### Sign in with OAuth (device flow)

A program running on the person's own machine can let them sign in with a browser and pick one of their API keys, instead of asking them to paste it:

```js
const client = new InternetData();

const device = await client.oauth.deviceAuthorization('your-client-id', {
    scope: 'account.read apikeys.read apikeys.reveal',
});
console.log(`Open ${device.verification_uri} and enter ${device.user_code}`);

const token = await client.oauth.pollDeviceToken('your-client-id', device);
if (token.apikey === undefined) {
    throw new Error("no API key came back: none was picked, or it can't be shown again");
}
const keyed = new InternetData({ apiKey: token.apikey });
```

A denied sign-in rejects with `OauthAccessDeniedError` and a code that ran out with `OauthExpiredTokenError`. Client IDs are issued on request from support@internetdata.io, and `client.oauth.revoke('your-client-id', token.refresh_token)` signs the machine out again.

### Sign in with OAuth (authorization code)

An app that can take a browser redirect signs the person in there instead, with a PKCE pair made for that one sign-in:

```js
const client = new InternetData();
const redirectUri = 'http://127.0.0.1:8765/callback';
const pkce = client.oauth.createPkce();

const url = client.oauth.authorizationUrl('your-client-id', redirectUri, pkce.challenge, {
    scope: 'apikeys.use', state: 'your-state',
});
// Open url in the browser. Its redirect to redirectUri carries code and state.
const token = await client.oauth.exchangeAuthorizationCode('your-client-id', code, pkce.verifier, redirectUri);
```

Check that `state` came back as you sent it before you exchange `code`, which works once. The client ID can also be the https URL of a client metadata document your app serves, and such an app is never handed a key, so `token.apikey` stays absent.

### Register a client

An app with no client ID, and no client metadata document to use as one, registers itself, then signs in with the `client_id` it gets back as the client ID for `authorizationUrl` and `exchangeAuthorizationCode`:

```js
const client = new InternetData();
const registration = await client.oauth.register(['http://127.0.0.1:8765/callback'], {
    clientName: 'Your App',
});
```

Each redirect URI must be https on a public host name, or http on a loopback address, which then matches any port. Nothing is kept until a person approves the client, so an app with no client ID saved can simply register again.

### Absent is not false

Unlimited leaves out `isVpn`, `isHosting`, `isCdn` and the four proxy flags, the detail behind them, and the paid members inside `location`, `asn`, `company` and `abuse`, such as `location.city`; a free-plan key's answer carries `trialExpired`, true once its daily trial is spent. A field your key does not include is `undefined`, which means "not in your plan" rather than "checked, and no".

```js
result.isVpn ?? false            // when you only want the flag
result.isVpn === undefined       // on Unlimited: not in your plan
result.trialExpired === true     // a free-plan key's daily trial is spent
```

## Other Libraries

There are official InternetData client libraries available for many languages including PHP, Python, Go, Java, and Ruby. See our GitHub at https://github.com/internetdata for more.

## About InternetData

Geolocation, anonymity, ownership and network data for IP addresses, AS numbers and domains, as an API and as databases you download and query yourself.

[<img src="https://s3.internetdata.io/internetdata-public/brand/mark.svg" alt="InternetData" height="64"/>](https://internetdata.io/)

## License

This project is licensed under the [MIT License](LICENSE).
