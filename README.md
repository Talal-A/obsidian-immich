# Obsidian ❤️ Immich

This plugin allows users to easily insert images from their self-hosted Immich instance into their Obsidian notes.

## Disclaimer

⚠️ The 'Immich Album Share Key' you generate below should be kept private! Do not post this online unless you are comfortable making your entire `obsidian` immich album public. This issue will only impact you if your immich instance is publicly accessible.

Your API key and album share key are stored in Obsidian's keychain, which encrypts them at rest using your operating system's credential store (macOS Keychain, Windows DPAPI, or a Linux secret store such as gnome-keyring). They are never written to the vault's `data.json`; only the name of the keychain entry is. You can review and revoke them at any time under **Settings → Keychain**.

## Features

- Browse a shared Immich album in a masonry grid that keeps each photo's own aspect ratio.
- Filter instantly by filename, place, or date; press Enter to run Immich's smart (content-based) search against the album.
- Select any number of photos or videos and insert them together, in the order you picked them.
- Optionally **download a copy into the vault** instead of linking, so notes keep working if the Immich server goes away.

## Prerequisites 
This assumes you have a working version of [immich](https://github.com/immich-app/immich) hosted. It does not necessarily need to be remotely accessible. This decision is left up to the reader.

Immich v3 and later are supported, as are older releases that still return the album's assets inline.

Obsidian 1.11.4 or later is required, since the plugin stores credentials using Obsidian's keychain (SecretStorage) API.

## Demo

https://github.com/user-attachments/assets/5ade12f7-c959-4991-9d6b-54bcb9569050

## Setup

**Immich**

1. Create an album on Immich. I suggest naming this 'obsidian'. This will contain all images that you want to use in obsidian moving forward.
2. Visit the album in the Immich WebUI. Take note of the UUID: `https://your-immich-url.com/albums/{UUID}`. 
3. Turn on link sharing for this album. Use the following settings:
   - Require password: No.
   - Show metadata: Yes.
   - Allow public user to download: Yes.
   - Allow public user to upload: No.
   - Expire after: Never.
4. Copy the share URL. Take note of the key: `https://your-immich-url.com/share/{{KEY}}`
5. Finally, generate and copy down your API key: `https://your-immich-url.com/user-settings?isOpen=api-keys`
    - The permissions currently used are: `server.about`, `album.read`, `asset.read`. Please note that future updates may change this.
    - `asset.read` is required because Immich v3 removed the asset list from the album endpoint; the plugin now lists album assets via the search API.

**Obsidian**

6. Install the plugin.
7. Fill in the following settings:
    - Immich URL: full url to your Immich instance. Do not include the trailing `/`.
    - Immich API key: click "Link", then add the key you generated in step 5 as a keychain entry.
    - Immich Album ID: the UUID you obtained in step 2.
    - Immich Album Share Key: click "Link", then add the Key you obtained in step 4 as a keychain entry.
8. Click "Test connection" to confirm connectivity. If any errors appear, you can view them in the console. Open the console using `cmd+option+i` (MacOS) or `ctrl+shift+i` (Windows). 

### Upgrading from 0.3.0 or earlier

Earlier versions kept the API key and album share key as plaintext in the vault's `data.json`. After updating, the plugin's settings tab shows a "Move to keychain" button that creates the keychain entries and deletes the plaintext copies. Nothing is moved until you press it.

Note that the plaintext values may still exist in backups, in vault sync history, or in your `.obsidian` folder's git history. If your Immich instance is publicly reachable, consider rotating the API key after migrating.

## Usage

### Basic usage
1. Go to the note you want to insert an image/video into. The editor view must be in focus.
1. Open the command palette in Obsidian (`ctrl/cmd + p` or swipe down on mobile).
1. Search "Immich".
1. Select `Immich: Insert from album` and click on the image(s) you want to include in your note.

### Available Commands
The following commands are available for use.

#### Insert from album
The standard insertion command. Please note you must have an open editor focused to use this command. Brings up the image selection modal.

In the picker:
- **Type** to filter the album instantly by filename, place, or date. Several words narrow the results rather than widening them.
- **Enter** runs Immich's smart search, which matches on what a photo shows rather than what it is called - so "sunset over water" works even when nothing is named that. This requires machine learning to be enabled on your Immich server.
- **Escape** clears the search; **Cmd/Ctrl+Enter** inserts the current selection.
- Click a photo to select it, then press Insert. Photos are inserted in the order you selected them.

### Downloading into the vault

By default the plugin inserts a link back to Immich, which means the note breaks if the
server is offline or the share link is revoked. Switch **Insert photos as** to "A copy
downloaded into the vault" in the settings, or use the Link/Download toggle in the
picker's footer to override it for a single insert.

Files land in your configured attachment folder, named `immich-<id>-<original name>`.
The id lets the plugin notice it has already downloaded a photo and link the existing
copy rather than fetching it again.

**Downloaded size** picks which rendition Immich serves:

| Size | Notes |
|---|---|
| Original | As uploaded. Requires the share link to allow downloads. Often HEIC from phones. |
| Large | Requires the share link to allow downloads. |
| Medium | Default. Rendered by Immich, always displayable, ~1-2 MB. |
| Small | Thumbnail-sized. |

Medium and Small are rendered by Immich as JPEG or WebP, so they always display in
Obsidian. **Originals from phones are usually HEIC, which Obsidian cannot show** - with
"Fall back to a rendered image" on (the default), the plugin notices and downloads
Immich's rendered version instead. With it off, the file is saved as-is and inserted as
a link rather than a broken embed.

**Shrink images after downloading** re-compresses images inside Obsidian to a maximum
edge length and JPEG quality. This strips EXIF metadata, including dates and location -
which also means that data does not end up in your vault. GIFs and SVGs are never
re-encoded.

Videos are never downloaded silently: if your selection includes any, the plugin asks
whether to download or link them, since videos are large and cannot be shrunk.

#### Refresh album cache
The "Insert from album" command caches some information such as available images/videos, urls, and other metadata related to the album when it is first run. If you find that new images or changes are not showing up in the image selection modal, running this command will refresh the caches.
