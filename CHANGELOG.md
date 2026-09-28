# Changelog

What each release changed for you, newest first. Each line is a commit's summary, linked to its full description and diff. Releases before 2.2.1 are described by their release commits.

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
