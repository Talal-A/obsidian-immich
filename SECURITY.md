# Security

## Reporting a vulnerability

Report privately through [GitHub's security advisory form](https://github.com/tuttopassastudios/obsidian-immich/security/advisories/new) rather than opening a public issue.

Useful things to include: what an attacker gets, the steps to reproduce, and the plugin and Obsidian versions. If a proof of concept involves your own Immich instance, please redact your URL, API key and share key — see below for why those are easy to leak by accident.

## What this plugin handles

Three pieces of configuration, two of which are credentials:

| Setting | Sensitive | Stored in |
| --- | --- | --- |
| Immich URL | No | `data.json` |
| Immich album ID | No | `data.json` |
| Immich API key | **Yes** | Obsidian keychain (`SecretStorage`) |
| Immich album share key | **Yes** | Obsidian keychain (`SecretStorage`) |

The API key is sent as an `x-api-key` header on requests to the album and search endpoints. The share key is used to fetch asset media, and is the credential that ends up in note content.

`data.json` holds only the *name* of each keychain entry, never a secret value. `ImmichCredentials` is deliberately a separate type from `PluginSettings` so that a resolved secret cannot be passed to `saveData()` by accident.

## Known exposure: the share key is written into notes

Inserted images and videos carry the share key in their URL, so it is persisted into the vault as note content. The key grants read access to the whole shared album.

This is documented for users in the [README](README.md#the-share-key-is-written-into-your-notes) and tracked in [issue #2](https://github.com/tuttopassastudios/obsidian-immich/issues/2). It is a design limitation rather than an oversight — but it is the plugin's most significant exposure, and any change to how assets are referenced should be weighed against it.

## Rules for contributors

These are enforced by lint or by review. Breaking one is a security bug, not a style nit.

**Never log a credential, or anything that contains one.** `no-console` is set to `error` in `eslint.config.mjs`, with `console.error` as the only exception. This is not fussiness about console noise: the README used to tell users to open the developer console when a connection failed, and the console printed the share key, so the documented troubleshooting path handed users a credential to paste into a public bug report.

Asset URLs carry the key in their query string, so a URL is as sensitive as the key itself. Use `withoutQuery()` before showing one to the user.

**Escape anything interpolated into note content.** `insertionTextFor()` writes markdown and HTML into the user's vault. The share key is `encodeURIComponent`-ed, the video `src` goes through `escapeAttribute()`, and image URLs are wrapped in angle brackets so a parenthesis cannot end the link early. Both values originate from settings a user pasted in — treat them as untrusted.

**Validate before trusting the URL.** `immichUrlProblem()` rejects any scheme that is not `http`/`https`. That one setting decides where the API key is sent, and the same string becomes an `<img>` src and part of a markdown link.

**Narrow responses at the boundary.** `requestUrl` types `json` as `any`. Run bodies through `asObject()` and `asText()` rather than indexing them directly; the type-aware lint rules will catch it if you do not.

## Verification

```bash
npm ci
npm run lint     # includes the no-console rule
npm run build    # type-checks, then bundles
npm audit        # should report zero vulnerabilities
```

Two greps worth running before a release:

```bash
grep -n "console\." main.ts                     # expect one console.error
grep -n "immichAlbumKey\|immichApiKey" main.ts  # every hit should be a request or URL, never a log
```

## Releases

Release artifacts are signed with [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), so a published `main.js` can be tied to the workflow run and commit that produced it:

```bash
gh attestation verify main.js --repo tuttopassastudios/obsidian-immich
```

The release build uses `npm ci` so the bundle matches the lockfile.
