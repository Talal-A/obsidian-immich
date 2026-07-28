# Changelog

## Unreleased — Immich v3 support, and a rebuilt picker

### Fixed

- **The picker works against Immich v3 again** ([#20](https://github.com/Talal-A/obsidian-immich/issues/20)). v3 removed the `assets` array from `GET /api/albums/{id}`, so the modal threw `Cannot read properties of undefined (reading 'length')` and rendered empty while the refresh notification still reported the right count from `assetCount`. Album assets are now listed via `POST /api/search/metadata`, falling back to the inline array when an older server supplies it. This needs the additional `asset.read` API key permission, which the README documents.
- The album share key is accepted as either the bare key or the whole share URL. The setup instructions have the user copy a URL and pick the key out of it, so the URL routinely ended up stored — producing a 401 whose message blamed the API key.
- HTTP failures explain themselves. `requestUrl` throws on any 4xx, so every failure used to surface as `Request failed, status 403`; a 403 now names the missing permission, a 401 names the credential that was rejected, and a 404 names the setting to check.
- Thumbnails no longer size themselves from `contentEl.innerWidth`, which does not exist on `HTMLElement` and left every image at `width={NaN}`.
- Assets of a type the plugin cannot insert no longer render a tile that inserts `undefined`, and the reported count matches the tiles on screen.
- Cache misses, refresh failures, and a missing keychain entry are handled rather than becoming unhandled promise rejections.

### Added

- **Credentials are stored in Obsidian's keychain** (`SecretStorage`, 1.11.4+), which encrypts them through the OS credential store. Only the name of the keychain entry is written to `data.json`. An upgrade that finds plaintext credentials offers a one-press migration and deletes the plaintext copies once the keychain writes succeed. `minAppVersion` moves to 1.11.4.
- **The picker is rebuilt.** A masonry grid keeps each photo's own aspect ratio instead of cropping to squares — the previous two-column flex assigned tiles by index rather than height, which stranded whitespace beside any tall photo. Clicking now selects rather than inserting immediately, so a misclick no longer writes markdown into the note, and a selection can be revised before it is committed.
- **Search.** Typing filters the cached album instantly by filename, place, and date. Pressing Enter runs Immich's smart search (`POST /api/search/smart`), which matches on what a photo depicts. Escape clears back to the album before it closes the modal.
- **Photos can be downloaded into the vault** instead of linked, so a note survives the server going away. Size is chosen from Immich's renditions with optional re-encoding to a maximum edge and JPEG quality. The default is the medium rendition rather than the original, because phone originals are usually HEIC — which Obsidian cannot display and a browser canvas cannot decode, so re-encoding cannot rescue them; an undisplayable original is re-fetched as Immich's rendered version. Videos are never downloaded without asking.


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

The share key is still embedded in every inserted *link*, so it is persisted into the vault and disclosed with any note that is shared or published. Tracked in [issue #2](https://github.com/tuttopassastudios/obsidian-immich/issues/2); see the README for what it means in practice.

Downloading into the vault avoids this entirely — a downloaded photo is referenced by its vault path, so no credential ends up in the note.
