# Obsidian ❤️ Immich

This plugin allows users to easily insert images from their self-hosted Immich instance into their Obsidian notes.

## Disclaimer

⚠️ The 'Immich Album Share Key' you generate below should be kept private! Do not post this online unless you are comfortable making your entire `obsidian` immich album public. This issue will only impact you if your immich instance is publicly accessible.

## Features

- View all images from a single shared album within Immich.
- One-click insertion of one or many images into your vault.

## Prerequisites 
This assumes you have a working version of [immich](https://github.com/immich-app/immich) hosted. It does not necessarily need to be remotely accessible. This decision is left up to the reader.

Immich v3 and later are supported, as are older releases that still return the album's assets inline.

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
    - Immich API key: the key you generated in step 5.
    - Immich Album ID: the UUID you obtained in step 2.
    - Immich Album Share Key: the Key you obtained in step 4.
8. Click "Test connection" to confirm connectivity. If any errors appear, you can view them in the console. Open the console using `cmd+option+i` (MacOS) or `ctrl+shift+i` (Windows). 

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

#### Refresh album cache
The "Insert from album" command caches some information such as available images/videos, urls, and other metadata related to the album when it is first run. If you find that new images or changes are not showing up in the image selection modal, running this command will refresh the caches.
