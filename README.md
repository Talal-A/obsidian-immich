# Obsidian ❤️ Immich

This plugin allows users to easily insert images from their self-hosted Immich instance into their Obsidian notes.

## Disclaimer
⚠️ Immich is still under **very active** development. Breaking changes have happened and will continue to happen! This plugin is confirmed working as of [v1.112.1](https://github.com/immich-app/immich/releases/tag/v1.112.1). 

⚠️ The 'Immich Album Share Key' you generate below should be kept private! Do not post this online unless you are comfortable making your entire `obsidian` immich album public. This issue will only impact you if your immich instance is publicly accessible.

## Features

- View all images from a single shared album within Immich.
- One-click insertion of one or many images into your vault.

## Prerequisites 
This assumes you have a working version of [immich](https://github.com/immich-app/immich) hosted. It does not necessarily need to be remotely accessible. This decision is left up to the reader.

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

**Obsidian**

6. Install the plugin.
7. Fill in the following settings:
    - Immich URL: full url to your Immich instance. Do not include the trailing `/`.
    - Immich API key: the key you just generated.
    - Immich Album ID: the UUID you obtained in step 2.
    - Immich Album Share Key: the Key you obtained in step 4.

## Usage
1. Open the command palette in Obsidian (`ctrl/cmd + p` or swipe down on mobile).
1. Search `Immich`.
1. Select `Immich: Insert from Immich` and click on the image(s) you want to include in your note.