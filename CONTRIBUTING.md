# Contributing

## Setup

```bash
npm ci
npm run dev     # rebuilds main.js on change
```

To test against a real vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/immich/`, then reload Obsidian (`cmd/ctrl + P` → "Reload app without saving"). `.hotreload` in this repo works with the [Hot Reload plugin](https://github.com/pjeby/hot-reload) if you would rather not reload by hand.

`main.js` is gitignored — it is a build artifact and is only attached to releases.

## Before opening a pull request

```bash
npm run lint
npm run build
npm audit
```

All three should be clean. `npm run build` type-checks before it bundles, so a type error fails the build rather than shipping.

## Toolchain notes

- **TypeScript is pinned to 5.9.** `typescript@latest` is 7.x, which `typescript-eslint` 8 does not support (`>=4.8.4 <6.1.0`). Do not bump it without checking that peer range.
- **Lint is flat config** (`eslint.config.mjs`), with type-aware rules enabled. That is deliberate: the rules that catch unawaited promises and untyped response data only work with type information.
- **`no-console` is an error**, allowing only `console.error`. See [SECURITY.md](SECURITY.md#rules-for-contributors) — this rule exists because the console used to print the album share key.

## Code conventions

Match what is already there rather than importing a different house style.

- Tabs, single quotes, semicolons.
- Comments explain *why*, not *what*. Most existing comments document a constraint that is not obvious from the code — an Immich API quirk, a reason a value is handled a particular way. Prefer that to narrating the next line.
- Styling belongs in `styles.css` under an `obsidian-immich-` class, not in `element.style`. Obsidian's plugin review flags inline styles; if a value genuinely has to be dynamic, use `setCssProps`.
- Use `activeWindow` rather than `window` for timers, so the picker works in a popout window.
- Use `this.app`, never the global `app`.

## Security-sensitive areas

Read [SECURITY.md](SECURITY.md) before touching any of these:

| Area | Why it is sensitive |
| --- | --- |
| `insertionTextFor()` | Writes markdown and HTML into the user's vault; carries the share key |
| `testConnection()` | Handles all three credentials; must not log them |
| `immichUrlProblem()` | Decides where the API key gets sent |
| `resolveCredentials()` / `migrateLegacySecrets()` | Reads and writes the OS keychain |
| `.github/workflows/release.yml` | Signs and publishes what users install |

## Releases

1. `npm version <patch|minor|major>` — updates `manifest.json` and `versions.json` via `version-bump.mjs`.
2. Push the tag. The workflow builds with `npm ci`, attests the artifacts, and opens a draft release.
3. Check the draft, then publish.

`minAppVersion` in `manifest.json` is 1.11.4 because the plugin stores credentials through Obsidian's `SecretStorage` API. Raise it if you use a newer API.
