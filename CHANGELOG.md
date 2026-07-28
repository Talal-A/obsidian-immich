# Changelog

## Unreleased — security pass

Addresses the findings from the [Obsidian community plugin scorecard](https://community.obsidian.md/plugins/immich), which reported 39 issues and a "Caution" review status, plus one exposure the automated scan could not see.

### Security

- **The album share key is no longer written to the developer console.** It was printed three times in `testConnection` — once directly, and twice inside asset URLs that carry it in their query string. The README's troubleshooting advice was to open the console and read the errors, so the one path a user followed when something broke was the path that handed them a credential to paste into a bug report.
- **Inserted URLs are escaped.** A quote in the share key could add attributes to the `<video>` tag, and a parenthesis in the Immich URL could end an image link early. The key is now `encodeURIComponent`-ed, video `src` values go through an attribute escape, and image URLs are wrapped in angle brackets.
- **The Immich URL is validated.** Any scheme other than `http`/`https` is rejected. That setting decides where the API key is sent and becomes an `<img>` src and part of a markdown link, so it is no longer passed through unchecked.
- **Twelve transitive dependency advisories cleared.** All arrived through `@typescript-eslint/eslint-plugin@5.29.0`, which nothing ran — `eslint` was not a dependency and there was no lint script. `npm audit` now reports zero vulnerabilities.
- **Release artifacts are signed** with build provenance attestation, and built with `npm ci` so the bundle matches the lockfile.

### Fixed

- Server responses are narrowed at the boundary instead of flowing through the code as `any`. Among other things this fixes a latent bug where `String(raw['id'] ?? '')` would have put `"[object Object]"` into a filename or an asset URL had Immich returned a non-string.
- `testConnection` is awaited, so a failure outside its own error handling is no longer an unhandled rejection. The button is disabled while it runs.
- The picker's timers are scheduled on `activeWindow`, so search and autofocus work in a popout window.
- An invalid or empty Immich URL produces a message naming the setting, rather than a bare `TypeError` from whichever request happened to be built first.

### Changed

- `testConnection` reports everything through notices. It still checks the three credentials in the order they are needed — server, then album, then an asset fetched with the share key — but the timing blocks and response dumps around those checks are gone. 23 console calls are down to one.
- Lint is real: `eslint` 10 with `typescript-eslint` 8, flat config, type-aware rules, and `no-console` set to error so the logging cleanup cannot regress. TypeScript moves to 5.9 to satisfy the peer range; `esbuild` moves off 0.17.3 for its own advisory.
- The Node builtins list comes from `node:module` rather than the `builtin-modules` package.

### Documentation

- `SECURITY.md` — reporting process, what the plugin handles, and the rules contributors need to follow around credentials.
- `CONTRIBUTING.md` — setup, checks, conventions, and the toolchain constraints that are easy to trip over.
- README documents that the share key is written into note content, what that exposes, and how to limit it.

### Known limitation

The share key is still embedded in every inserted link, so it is persisted into the vault and disclosed with any note that is shared or published. Tracked in [issue #2](https://github.com/tuttopassastudios/obsidian-immich/issues/2); see the README for what it means in practice.
