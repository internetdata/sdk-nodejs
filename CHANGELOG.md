# Changelog

What each release changed for you, newest first. Each line is a commit's summary, linked to its full description and diff. Releases before 2.2.1 are described by their release commits.

## 2.7.4 - 2026-10-23

### Fixes

- Refuse a checksum answer without its id or format ([`5a27c14`](https://github.com/internetdata/sdk-nodejs/commit/5a27c147182f7c59f1fadcc2db5f77b3df0ad537))
- Refuse an OAuth integer member that is not a whole number ([`4c51681`](https://github.com/internetdata/sdk-nodejs/commit/4c51681d5bf13f31159e634a3b88a763a82a82b8))
- Refuse a key past U+00FF and a bad retry count where they are set ([`da94dc8`](https://github.com/internetdata/sdk-nodejs/commit/da94dc8e284b350e9e9ba31c21ee4bc10fb7668b))

## 2.7.3 - 2026-10-21

### Fixes

- Re-pin the spec to 2026.10.21: a 403 for a refused address ([`b294a39`](https://github.com/internetdata/sdk-nodejs/commit/b294a39c09ce7a564a63300e37613a78849a109c))

## 2.7.2 - 2026-10-19

### Fixes

- Refuse a database sample that is not rows of objects ([`2dd3733`](https://github.com/internetdata/sdk-nodejs/commit/2dd37332bb1c667176a1a99edca30193ac6c4bdf))

## 2.7.1 - 2026-10-18

### Fixes

- Re-pin the spec to 2026.10.18: client_id_issued_at is int64 ([`46e57e6`](https://github.com/internetdata/sdk-nodejs/commit/46e57e6a6bb2099c2afe530ead56bcb559e5b476))

## 2.7.0 - 2026-10-18

### Features

- Add oauth.register, for RFC 7591 dynamic client registration ([`f4b08d6`](https://github.com/internetdata/sdk-nodejs/commit/f4b08d68bc55cb0b276d6101eae89b6efaebc8e3))

### Fixes

- Report an OAuth answer that is not JSON as a server_error with its status ([`e9c0fa6`](https://github.com/internetdata/sdk-nodejs/commit/e9c0fa60e748ad9fe0d4575d1e0d94a22a643d92))

## 2.6.0 - 2026-10-17

### Features

- Re-pin the spec to 2026.10.16: dynamic client registration ([`da4aaf3`](https://github.com/internetdata/sdk-nodejs/commit/da4aaf3ae67e228921c0f780d7d1e385aba6a5b4))

## 2.5.5 - 2026-10-16

### Fixes

- Retry a database answer whose member has the wrong type ([`419892f`](https://github.com/internetdata/sdk-nodejs/commit/419892f1cc044028c992583507c91e5eed14d509))

## 2.5.4 - 2026-10-16

### Fixes

- Re-pin the spec to 2026.10.15: three descriptions in US spelling ([`2570c67`](https://github.com/internetdata/sdk-nodejs/commit/2570c6728580aec5528f93814050fd7c332d344c))

## 2.5.3 - 2026-10-13

### Fixes

- Re-pin the spec to 2026.10.13: Open databases come with a license ([`f9c7166`](https://github.com/internetdata/sdk-nodejs/commit/f9c7166971fce0c0d706aac22e0fc6bad476eee8))

## 2.5.2 - 2026-10-10

### Fixes

- Read a Retry-After as seconds or an HTTP date, and nothing else ([`790afe2`](https://github.com/internetdata/sdk-nodejs/commit/790afe286ea954cf91171b4ebc931815e8f351cb))
- Retry a 2xx a database call cannot read, as a server_error with its status ([`0108438`](https://github.com/internetdata/sdk-nodejs/commit/0108438e37a716ac8bef2ee4bde0cac181774f39))
- Send the API key trimmed, none for blanks, and refuse a control character ([`2c25cc5`](https://github.com/internetdata/sdk-nodejs/commit/2c25cc5478cc0f6cc3a48a8e588aa89014dac62b))

## 2.5.1 - 2026-10-10

### Fixes

- Re-pin the spec to 2026.10.09: rotating a key needs apikeys.reveal ([`e932898`](https://github.com/internetdata/sdk-nodejs/commit/e9328981d9929d7bdd5f0490627030b30a28973f))
- Fail a throttled call at once when no retry is left ([`349f0dd`](https://github.com/internetdata/sdk-nodejs/commit/349f0ddf543e4dd88e4dd0717e00532ed05b2fe5))

## 2.5.0 - 2026-10-09

### Features

- Re-pin the spec to 2026.10.08, adding the Open databases' open flag ([`043104a`](https://github.com/internetdata/sdk-nodejs/commit/043104ae94fe417825691360b7d267111118b938))

## 2.4.1 - 2026-10-04

### Fixes

- Re-pin the spec to 2026.10.03: metadata needs no license ([`e064300`](https://github.com/internetdata/sdk-nodejs/commit/e06430099723639ce29ac67e18af30186bb922b0))

## 2.4.0 - 2026-09-29

### Features

- Add the authorization code sign-in, with PKCE ([`b4a875e`](https://github.com/internetdata/sdk-nodejs/commit/b4a875e41b76881b31178a6cac57166553e15f42))

## 2.3.2 - 2026-09-29

### Fixes

- README: link the evaluation request, not a mailbox ([`dca724b`](https://github.com/internetdata/sdk-nodejs/commit/dca724b0c86351998a0a85bc9239d4ab6fe72b40))

## 2.3.1 - 2026-09-28

### Fixes

- Drop every trailing slash, and refuse a timeout no attempt can meet ([`679b0d8`](https://github.com/internetdata/sdk-nodejs/commit/679b0d84aece8c0f52a4c0b16171f4e62a2d6af2))
- End the poll's sleep at its deadline, and wait past setTimeout's ceiling ([`2b0f7f0`](https://github.com/internetdata/sdk-nodejs/commit/2b0f7f023a2d4aba537b2c5486d03eff52c80556))

## 2.3.0 - 2026-09-27

### Features

- Re-pin the spec to 2026.09.26, adding its evaluation-sample fields ([`76d7ab1`](https://github.com/internetdata/sdk-nodejs/commit/76d7ab1d8d1a3e04749496b807d1c1c2b4cf8f24))

## 2.2.1 - 2026-09-22

### Fixes

- Stop explaining in the docs how a private database is hidden ([`638e03e`](https://github.com/internetdata/sdk-nodejs/commit/638e03e0aa0a427a0d8d3552886f6142fddca786))
- README: only the database calls need a key; oauth takes none ([`c7fbfd7`](https://github.com/internetdata/sdk-nodejs/commit/c7fbfd7ce907a03db9bf2c12b8d39793451936d8))
