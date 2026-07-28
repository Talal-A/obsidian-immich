import { App, Editor, MarkdownFileInfo, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, RequestUrlParam, RequestUrlResponse, SecretComponent, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

// Whether an insert links back to Immich or saves a copy into the vault.
type InsertMode = 'link' | 'download';
// The renditions Immich can serve. Everything except 'original' is transcoded
// server-side to a format Obsidian can display.
type RenditionSize = 'original' | 'fullsize' | 'preview' | 'thumbnail';

interface PluginSettings {
	immichUrl: string;
	immichAlbum: string;
	// IDs of entries in Obsidian's keychain. The secret values themselves are
	// never persisted here - only the name that points at them.
	immichApiKeySecret: string;
	immichAlbumKeySecret: string;
	// Plaintext credentials written by versions before 0.4.0. These are only
	// read so that they can be offered for migration into the keychain, and are
	// cleared once the user accepts.
	immichApiKey?: string;
	immichAlbumKey?: string;

	insertMode: InsertMode;
	downloadSize: RenditionSize;
	reencode: boolean;
	maxEdge: number;
	jpegQuality: number;
	reuseExistingDownloads: boolean;
	renditionFallback: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	immichUrl: '',
	immichAlbum: '',
	immichApiKeySecret: '',
	immichAlbumKeySecret: '',
	// Linking is the pre-0.7.0 behaviour, so upgrades change nothing until asked.
	insertMode: 'link',
	// 'preview' rather than 'original': Immich transcodes it, so it is always
	// something Obsidian can render. See isRenderable().
	downloadSize: 'preview',
	reencode: false,
	maxEdge: 2048,
	jpegQuality: 0.85,
	reuseExistingDownloads: true,
	renditionFallback: true
}

function clamp(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

const API_KEY_SECRET_ID = 'immich-api-key';
const ALBUM_KEY_SECRET_ID = 'immich-album-share-key';

// The credentials the plugin actually talks to Immich with, with the secrets
// resolved out of the keychain. Deliberately kept separate from PluginSettings
// so that secret values can never be handed to saveData().
interface ImmichCredentials {
	immichUrl: string;
	immichAlbum: string;
	immichApiKey: string;
	immichAlbumKey: string;
}

interface ImmichAsset {
	id: string;
	type: string;
	fileName: string;
	// ISO timestamp, kept as the raw string - only ever shown as a date and
	// matched as text, so there is no reason to parse it.
	taken: string;
	place: string;
	// Native pixel dimensions, 0 when Immich does not report them. Used only to
	// reserve the right shape before the thumbnail loads.
	width: number;
	height: number;
	// Only consulted when naming a downloaded original; Immich marks it optional.
	mimeType: string;
}

// Immich returns a large asset object; keep only what the picker displays or
// searches on, since the whole album is held in memory.
function toImmichAsset(raw: Record<string, unknown>): ImmichAsset {
	const exif = (raw['exifInfo'] ?? {}) as Record<string, unknown>;
	const place = [exif['city'], exif['country']].filter(Boolean).join(', ');
	return {
		id: String(raw['id'] ?? ''),
		type: String(raw['type'] ?? ''),
		fileName: String(raw['originalFileName'] ?? ''),
		taken: String(raw['localDateTime'] ?? raw['fileCreatedAt'] ?? ''),
		place: place,
		width: Number(raw['width'] ?? exif['exifImageWidth'] ?? 0) || 0,
		height: Number(raw['height'] ?? exif['exifImageHeight'] ?? 0) || 0,
		mimeType: String(raw['originalMimeType'] ?? '')
	};
}

// Everything the search box matches against, precomputed per asset.
function assetHaystack(asset: ImmichAsset): string {
	return [asset.fileName, asset.place, asset.taken.slice(0, 10), asset.type].join(' ').toLowerCase();
}

function matchesQuery(asset: ImmichAsset, tokens: string[]): boolean {
	if (tokens.length === 0) return true;
	const haystack = assetHaystack(asset);
	// Every token must match somewhere, so extra words narrow rather than widen.
	return tokens.every(token => haystack.includes(token));
}

interface AlbumCache {
	albumName: string;
	assets: ImmichAsset[];
	fingerprint: string;
}

let cachedResult: AlbumCache | null = null;

function normalizeImmichUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

// The setup instructions have the user copy a share URL and pick the key out of
// it, so the whole URL routinely ends up stored instead. Immich then receives a
// URL where it expects a token and answers 401, which is an unhelpful way to
// find out. Accept either form.
function normalizeAlbumShareKey(value: string): string {
	let key = value.trim();
	const marker = key.lastIndexOf('/share/');
	if (marker !== -1) {
		key = key.slice(marker + '/share/'.length);
	}
	// Drop anything after the key itself, plus any trailing separators.
	key = key.split(/[?#]/)[0];
	return key.replace(/\/+$/, '');
}

function resolveCredentials(app: App, settings: PluginSettings): ImmichCredentials {
	const readSecret = (id: string): string => {
		if (!id) return '';
		return app.secretStorage.getSecret(id) ?? '';
	};
	return {
		immichUrl: settings.immichUrl,
		immichAlbum: settings.immichAlbum,
		immichApiKey: readSecret(settings.immichApiKeySecret).trim(),
		// Normalized on read rather than on input: the value lives in the
		// keychain, which the user edits through Obsidian's own UI.
		immichAlbumKey: normalizeAlbumShareKey(readSecret(settings.immichAlbumKeySecret))
	};
}

// Identifies the credentials the cache was built from, so that changing the
// instance/album - or rotating a secret in the keychain - invalidates it
// instead of showing stale assets.
function credentialsFingerprint(creds: ImmichCredentials): string {
	return JSON.stringify([creds.immichUrl, creds.immichAlbum, creds.immichApiKey, creds.immichAlbumKey]);
}

function apiHeaders(creds: ImmichCredentials): Record<string, string> {
	return {
		'Accept': 'application/json',
		'x-api-key': creds.immichApiKey
	};
}

// The permissions the plugin's API key needs. `asset.read` is the one that
// existing keys tend to lack, since it only became necessary when Immich v3
// moved album listing to the search API.
const REQUIRED_PERMISSIONS = 'server.about, album.read, and asset.read';

// Which credential a given request is authenticated by, so that a rejection can
// point at the setting that actually needs fixing. Asset media is fetched with
// the album share key; everything else uses the API key.
type AuthKind = 'api-key' | 'share-key' | 'share-key-download';

// Downloading an original is gated by the share link's download permission,
// which is a different switch from the one that lets thumbnails be viewed.
const SHARE_DOWNLOAD_HINT = 'Downloading full-size assets requires the album share link to have ' +
	'"Allow public user to download" enabled in Immich. Alternatively set the downloaded size to ' +
	'Medium in the plugin settings, which does not need it.';

function describeHttpFailure(status: number, context: string, auth: AuthKind): string {
	switch (status) {
		case 401:
			if (auth === 'share-key-download') {
				return 'Immich rejected the request (401) while ' + context + '. ' + SHARE_DOWNLOAD_HINT;
			}
			return auth === 'share-key'
				? 'Immich rejected the album share key (401) while ' + context + '. Check it in the plugin ' +
					'settings - it should be only the key from the end of the share URL, not the whole URL.'
				: 'Immich rejected the API key (401) while ' + context + '. Check the API key in the plugin settings.';
		case 403:
			if (auth === 'share-key-download') {
				return 'Immich denied access (403) while ' + context + '. ' + SHARE_DOWNLOAD_HINT;
			}
			return auth === 'share-key'
				? 'Immich denied access (403) while ' + context + '. The album share link may have expired, or ' +
					'the album share key may be wrong.'
				: 'Immich denied access (403) while ' + context + '. The API key is most likely missing a ' +
					'required permission - this plugin needs ' + REQUIRED_PERMISSIONS + '.';
		case 400:
			// Smart search is the one call that depends on the server having
			// machine learning turned on, so a rejected request usually means that.
			return 'Immich rejected the request (400) while ' + context +
				'. Smart search requires machine learning to be enabled on your Immich server.';
		case 404:
			return 'Immich returned not found (404) while ' + context + '. Check the Immich URL and album ID.';
		default:
			return 'Immich returned status ' + status + ' while ' + context + '.';
	}
}

// requestUrl throws its own opaque "Request failed, status NNN" for any 4xx/5xx,
// which hides which permission or setting is actually at fault. Handle the
// status directly so the failure can be explained in terms the user can act on.
async function immichRequest(params: RequestUrlParam, context: string, auth: AuthKind = 'api-key'): Promise<RequestUrlResponse> {
	const result = await requestUrl({ ...params, throw: false });
	if (result.status < 200 || result.status >= 300) {
		throw new Error(describeHttpFailure(result.status, context, auth));
	}
	return result;
}

function hasLegacyPlaintextSecrets(settings: PluginSettings): boolean {
	return !!(settings.immichApiKey || settings.immichAlbumKey);
}

// Secret IDs must be lowercase alphanumeric with optional dashes. Pick the
// plain name when it is free, otherwise suffix it so that migrating never
// overwrites a secret another plugin (or an earlier vault) already owns.
function availableSecretId(app: App, preferredId: string): string {
	const taken = new Set(app.secretStorage.listSecrets());
	if (!taken.has(preferredId)) return preferredId;
	for (let i = 2; i < 100; i++) {
		const candidate = preferredId + '-' + i;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error('Could not find an unused secret ID for ' + preferredId);
}

function describeException(exception: unknown): string {
	return exception instanceof Error ? exception.message : String(exception);
}

async function testConnection(creds: ImmichCredentials) {
	const url = new URL(creds.immichUrl + '/api/server/about');
	console.log('[Immich] Testing connection to:', url.toString());
	console.log('[Immich] API key configured:', creds.immichApiKey ? '✓ (present)' : '✗ (missing)');
	
	new Notice("Testing connection to " + url);
	try {
		const startTime = Date.now();
		const result = await immichRequest({
			url: url.toString(),
			headers: apiHeaders(creds)
		}, 'contacting the server')
		const duration = Date.now() - startTime;

		console.log('[Immich] Connection response:', {
			status: result.status,
			statusText: result.status === 200 ? 'OK' : 'Error',
			duration: `${duration}ms`,
			headers: result.headers
		});
		
		if (result.status == 200) {
			console.log('[Immich] Server info:', result.json);
			new Notice("Connection successful")
		} else {
			console.warn('[Immich] Unexpected status code:', result.status);
		}
	} catch(exception) {
		console.error('[Immich] Connection failed:', {
			url: url.toString(),
			error: exception,
			errorMessage: exception instanceof Error ? exception.message : String(exception),
			settings: {
				immichUrl: creds.immichUrl,
				hasApiKey: !!creds.immichApiKey
			}
		});
		new Notice("Failed to connect to " + creds.immichUrl + ". " + describeException(exception))
	}	
	const url2 = new URL(creds.immichUrl + '/api/albums/' + creds.immichAlbum);
	console.log('[Immich] Testing album access with URL:', url2.toString());
	let albumResult: RequestUrlResponse | null = null;
	try {
		const startTime = Date.now();
		const result = await immichRequest({
			url: url2.toString(),
			headers: apiHeaders(creds)
		}, 'loading the album')
		const duration = Date.now() - startTime;
		
		console.log('[Immich] Album access response:', {
			status: result.status,
			statusText: result.status === 200 ? 'OK' : 'Error',
			duration: `${duration}ms`,
			headers: result.headers
		});
		
		if (result.status == 200) {
			albumResult = result;
			console.log('[Immich] Album info:', result.json);
			new Notice("Album access successful - found " + result.json['assetCount'] + " assets.");
		} else {
			console.warn('[Immich] Unexpected status code when accessing album:', result.status);
		}
	} catch(exception) {
		console.error('[Immich] Album access failed:', {
			url: url2.toString(),
			error: exception,
			errorMessage: exception instanceof Error ? exception.message : String(exception),
			settings: {
				immichUrl: creds.immichUrl,
				hasApiKey: !!creds.immichApiKey,
				albumId: creds.immichAlbum
			}
		});
		new Notice("Failed to access album. " + describeException(exception))
	}
	// If there is an item in the album, also test access to the first asset to verify that the album key is correct.
	// Immich v3 no longer inlines the assets in the album response, so look them up separately when needed.
	let firstAsset: ImmichAsset | null = null;
	if (albumResult) {
		try {
			const assets = await fetchAlbumAssets(creds, albumResult.json ?? {});
			firstAsset = assets[0] ?? null;
			if (assets.length === 0) {
				console.log('[Immich] Album contains no assets - skipping asset access test.');
			}
		} catch (exception) {
			console.error('[Immich] Failed to list album assets:', exception);
			new Notice("Failed to list album assets. " + describeException(exception));
		}
	}
	if (firstAsset) {
		const assetId = firstAsset['id'];
		const url3 = new URL(creds.immichUrl + '/api/assets/' + assetId + '/thumbnail?size=thumbnail&key=' + creds.immichAlbumKey);
		console.log('[Immich] Testing asset access with URL:', url3.toString());
		try {
			const startTime = Date.now();
			const result = await immichRequest({
				url: url3.toString(),
				headers: apiHeaders(creds)
			}, 'reading an asset thumbnail', 'share-key')
			const duration = Date.now() - startTime;
			
			console.log('[Immich] Asset access response:', {
				status: result.status,
				statusText: result.status === 200 ? 'OK' : 'Error',
				duration: `${duration}ms`,
				headers: result.headers
			});
			
			if (result.status == 200) {
				console.log('[Immich] Asset access successful');
				new Notice("Asset access successful - album key is correct.");
			} else {
				console.warn('[Immich] Unexpected status code when accessing asset:', result.status);
			}
		} catch(exception) {
			console.error('[Immich] Asset access failed:', {
				url: url3.toString(),
				error: exception,
				errorMessage: exception instanceof Error ? exception.message : String(exception),
				settings: {
					immichUrl: creds.immichUrl,
					hasApiKey: !!creds.immichApiKey,
					albumId: creds.immichAlbum,
					albumKey: creds.immichAlbumKey
				}
			});
			new Notice("Failed to access asset. " + describeException(exception) + " This may also indicate an issue with the album share key.");
		}
	}
}

// Immich v3 removed the `assets` array from the album response, so the assets
// have to be fetched separately via the search API. Older servers still inline
// them, so use those when present to avoid an extra round trip.
async function fetchAlbumAssets(creds: ImmichCredentials, album: Record<string, unknown>): Promise<ImmichAsset[]> {
	const inlined = album['assets'];
	if (Array.isArray(inlined)) {
		return inlined.map(toImmichAsset);
	}

	const url = new URL(creds.immichUrl + '/api/search/metadata');
	const order = album['order'] === 'asc' ? 'asc' : 'desc';
	const pageSize = 1000; // Maximum permitted by the search API.
	const assets: ImmichAsset[] = [];
	let page = 1;

	// The search API is paginated and reports the next page to request, if any.
	while (page > 0) {
		const result = await immichRequest({
			url: url.toString(),
			method: 'POST',
			headers: { ...apiHeaders(creds), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				albumIds: [creds.immichAlbum],
				order: order,
				page: page,
				size: pageSize,
				// Supplies the city/country the picker's search matches on.
				withExif: true
			})
		}, 'listing the album\'s assets');

		const searchAssets = result.json?.['assets'];
		const items: Record<string, unknown>[] = searchAssets?.['items'] ?? [];
		assets.push(...items.map(toImmichAsset));

		const nextPage = Number(searchAssets?.['nextPage']);
		page = Number.isFinite(nextPage) && nextPage > page ? nextPage : 0;

		// Defensive stop: a server that keeps handing back a next page would
		// otherwise loop forever.
		if (items.length === 0) {
			break;
		}
	}

	return assets;
}

// Immich's smart search is CLIP-based: it matches on what a photo depicts
// rather than on its filename, so it has to run server-side. Results come back
// ranked by relevance, so only the first page is worth taking.
const SMART_SEARCH_LIMIT = 250;

async function smartSearch(creds: ImmichCredentials, query: string, type: string): Promise<ImmichAsset[]> {
	const body: Record<string, unknown> = {
		query: query,
		albumIds: [creds.immichAlbum],
		size: SMART_SEARCH_LIMIT,
		page: 1,
		withExif: true
	};
	if (type !== 'ALL') {
		body['type'] = type;
	}

	const result = await immichRequest({
		url: new URL(creds.immichUrl + '/api/search/smart').toString(),
		method: 'POST',
		headers: { ...apiHeaders(creds), 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}, 'running a smart search');

	const items: Record<string, unknown>[] = result.json?.['assets']?.['items'] ?? [];
	return items.map(toImmichAsset);
}

async function refreshCacheFromImmich(creds: ImmichCredentials, silent=true) {
	// A missing secret usually means the keychain entry was deleted or renamed,
	// which is worth saying plainly rather than sending an unauthenticated call.
	if (!creds.immichUrl || !creds.immichAlbum || !creds.immichApiKey) {
		throw new Error('Immich URL, album ID, and API key must all be configured in the plugin settings.');
	}

	const url = new URL(creds.immichUrl + '/api/albums/' + creds.immichAlbum);
	const result = await immichRequest({
		url: url.toString(),
		headers: apiHeaders(creds)
	}, 'loading the album');

	const album = result.json ?? {};
	const assets = await fetchAlbumAssets(creds, album);

	cachedResult = {
		albumName: album['albumName'] ?? '',
		assets: assets,
		fingerprint: credentialsFingerprint(creds)
	};

	if(!silent) {
		new Notice('Immich album cache completed for album \'' + cachedResult.albumName + '\'. Found ' + assets.length + ' assets.');
	}
}

export default class ObsidianImmich extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'insert-from-album',
			name: 'Insert from album',
			// The source note's path drives Obsidian's per-folder attachment
			// settings and the relative links generated for downloaded files.
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const sourcePath = ctx?.file?.path ?? '';
				new ImageSelectorModal(this.app, editor, sourcePath, this.credentials(), this.settings).open();
			}
		});

		this.addCommand({
			id: 'force-refresh-album-cache',
			name: 'Refresh album cache',
			callback: () => {
				new Notice('Refreshing immich cache.');
				refreshCacheFromImmich(this.credentials(), false).catch((error) => {
					console.error('[Immich] Failed to refresh album cache:', error);
					new Notice('Failed to refresh the immich album cache. ' + describeException(error));
				});
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// Nudge users upgrading from a version that kept credentials in
		// data.json. The migration itself is not run without their say-so.
		if (hasLegacyPlaintextSecrets(this.settings)) {
			new Notice(
				'Immich: your API key and album share key are still stored in plaintext. ' +
				'Open the Immich plugin settings to move them into Obsidian\'s keychain.',
				15000
			);
		}
	}

	onunload() {
	}

	// Resolved fresh on each use so that editing a secret in the keychain takes
	// effect without reloading the plugin.
	credentials(): ImmichCredentials {
		return resolveCredentials(this.app, this.settings);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.immichUrl = normalizeImmichUrl(this.settings.immichUrl);
		// data.json is user-editable, so the numeric settings are re-clamped
		// rather than trusted.
		this.settings.maxEdge = clamp(Number(this.settings.maxEdge), 256, 8192, DEFAULT_SETTINGS.maxEdge);
		this.settings.jpegQuality = clamp(Number(this.settings.jpegQuality), 0.3, 1, DEFAULT_SETTINGS.jpegQuality);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Moves the pre-0.4.0 plaintext credentials into the keychain and removes
	// them from data.json. Only invoked from the settings tab, on request.
	async migrateLegacySecrets() {
		const migrated: string[] = [];

		if (this.settings.immichApiKey) {
			const id = this.settings.immichApiKeySecret || availableSecretId(this.app, API_KEY_SECRET_ID);
			this.app.secretStorage.setSecret(id, this.settings.immichApiKey);
			this.settings.immichApiKeySecret = id;
			migrated.push(id);
		}
		if (this.settings.immichAlbumKey) {
			const id = this.settings.immichAlbumKeySecret || availableSecretId(this.app, ALBUM_KEY_SECRET_ID);
			this.app.secretStorage.setSecret(id, this.settings.immichAlbumKey);
			this.settings.immichAlbumKeySecret = id;
			migrated.push(id);
		}

		// Only drop the plaintext copies once the keychain writes have gone
		// through, so a failure above can never lose the user's credentials.
		delete this.settings.immichApiKey;
		delete this.settings.immichAlbumKey;
		await this.saveSettings();

		return migrated;
	}
}

// ---------------------------------------------------------------------------
// Downloading assets into the vault
// ---------------------------------------------------------------------------

// requestUrl does not guarantee header name casing across platforms.
function headerValue(headers: Record<string, string>, name: string): string {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers ?? {})) {
		if (key.toLowerCase() === wanted) return headers[key] ?? '';
	}
	return '';
}

const MIME_EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/gif': 'gif',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/tiff': 'tiff',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'video/x-matroska': 'mkv'
};

// What Obsidian will actually render in a note. Anything else embeds as a
// broken image box, so it gets linked rather than embedded.
const RENDERABLE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);
const RENDERABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

// Re-encoding these is a downgrade rather than a saving: it would flatten an
// animation, or rasterise a vector.
const NEVER_REENCODE = new Set(['gif', 'svg']);

function splitFileName(name: string): {stem: string, ext: string} {
	const clean = (name ?? '').trim();
	const dot = clean.lastIndexOf('.');
	if (dot <= 0 || dot === clean.length - 1) return {stem: clean, ext: ''};
	return {stem: clean.slice(0, dot), ext: clean.slice(dot + 1).toLowerCase()};
}

function sanitizeFileStem(stem: string): string {
	const cleaned = (stem || 'photo')
		// Characters that are illegal in a filename on some platform, or that
		// would confuse Obsidian's own link parser.
		.replace(/[\\/:*?"<>|#^[\]]/g, '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return (cleaned || 'photo').slice(0, 48);
}

function mimeExtension(contentType: string): string {
	const base = (contentType || '').split(';')[0].trim().toLowerCase();
	return MIME_EXTENSIONS[base] ?? '';
}

// A rendition's format is whatever the server chose, so the response wins. An
// original's format is whatever was uploaded, and the filename is the most
// reliable record of that - the body is served as octet-stream either way.
function extensionForDownload(asset: ImmichAsset, contentType: string, size: RenditionSize): string {
	if (asset.type === 'VIDEO') {
		return mimeExtension(contentType) || splitFileName(asset.fileName).ext || 'mp4';
	}
	if (size !== 'original') {
		return mimeExtension(contentType) || 'jpg';
	}

	const named = splitFileName(asset.fileName).ext;
	if (/^[a-z0-9]{1,5}$/.test(named)) return named;

	const fromAsset = mimeExtension(asset.mimeType);
	if (fromAsset) return fromAsset;

	const fromResponse = mimeExtension(contentType);
	if (fromResponse) return fromResponse;

	// Last resort: derive something from the subtype, e.g. image/x-canon-cr2.
	const subtype = (contentType || '').split(';')[0].split('/')[1] ?? '';
	const guess = subtype.replace(/^x-/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
	return guess ? guess.slice(0, 5) : 'bin';
}

function isRenderable(asset: ImmichAsset, ext: string): boolean {
	return asset.type === 'VIDEO'
		? RENDERABLE_VIDEO_EXTENSIONS.has(ext)
		: RENDERABLE_IMAGE_EXTENSIONS.has(ext);
}

// The asset id is embedded so that a later insert of the same photo can find
// the existing copy without the plugin having to persist any index.
function downloadFileName(asset: ImmichAsset, ext: string): string {
	const stem = sanitizeFileStem(splitFileName(asset.fileName).stem);
	return 'immich-' + asset.id.slice(0, 8) + '-' + stem + '.' + ext;
}

function assetMediaUrl(creds: ImmichCredentials, asset: ImmichAsset, size: RenditionSize): string {
	const base = creds.immichUrl + '/api/assets/' + asset.id;
	const key = encodeURIComponent(creds.immichAlbumKey);
	if (asset.type === 'VIDEO') {
		return base + '/video/playback?key=' + key;
	}
	if (size === 'original') {
		return base + '/original?key=' + key;
	}
	return base + '/thumbnail?size=' + size + '&key=' + key;
}

// 'original' and 'fullsize' both end up at the download endpoint, which the
// share link may not permit even when viewing thumbnails works.
function authKindForSize(size: RenditionSize): AuthKind {
	return size === 'original' || size === 'fullsize' ? 'share-key-download' : 'share-key';
}

interface FetchedAsset {
	data: ArrayBuffer;
	contentType: string;
	sizeUsed: RenditionSize;
}

async function fetchAssetBytes(creds: ImmichCredentials, asset: ImmichAsset, size: RenditionSize): Promise<FetchedAsset> {
	const attempt = async (which: RenditionSize): Promise<FetchedAsset> => {
		const result = await immichRequest({
			url: assetMediaUrl(creds, asset, which),
			headers: apiHeaders(creds)
		}, 'downloading ' + (asset.fileName || 'an asset'), authKindForSize(which));
		return {
			data: result.arrayBuffer,
			contentType: headerValue(result.headers, 'content-type'),
			sizeUsed: which
		};
	};

	try {
		return await attempt(size);
	} catch (error) {
		// A share link without download permission can serve previews but not
		// originals, so fall back rather than failing the whole import.
		const denied = /\(40[13]\)/.test(describeException(error));
		if (denied && asset.type !== 'VIDEO' && (size === 'original' || size === 'fullsize')) {
			return await attempt('preview');
		}
		throw error;
	}
}

// ---- client-side re-encode ------------------------------------------------

function scaledDimensions(width: number, height: number, maxEdge: number): {width: number, height: number} {
	const longest = Math.max(width, height);
	if (maxEdge <= 0 || longest <= maxEdge) return {width, height};
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

function canvasToArrayBuffer(canvas: HTMLCanvasElement, quality: number): Promise<ArrayBuffer | null> {
	return new Promise(resolve => {
		canvas.toBlob(blob => {
			if (!blob) {
				resolve(null);
				return;
			}
			blob.arrayBuffer().then(resolve).catch(() => resolve(null));
		}, 'image/jpeg', quality);
	});
}

// Returns null whenever re-encoding is impossible or pointless, in which case
// the caller keeps the bytes it already has. HEIC lands here: the browser
// cannot decode it, so this is not the place that rescues it - see the
// rendition fallback in AssetImporter.
async function reencodeImage(
	data: ArrayBuffer, contentType: string, ext: string, maxEdge: number, quality: number
): Promise<{data: ArrayBuffer, ext: string} | null> {
	if (NEVER_REENCODE.has(ext)) return null;

	let bitmap: ImageBitmap | null = null;
	try {
		const blob = new Blob([data], {type: contentType || 'image/jpeg'});
		// Bake in the EXIF rotation: re-encoding drops the metadata, so an
		// unrotated bitmap would be permanently sideways.
		// Cast: 'from-image' postdates the DOM lib this project compiles against,
		// but it is what Chromium implements and what Obsidian runs on.
		bitmap = await createImageBitmap(blob, {imageOrientation: 'from-image'} as unknown as ImageBitmapOptions);

		const target = scaledDimensions(bitmap.width, bitmap.height, maxEdge);
		// Nothing to shrink and nothing to squeeze - leave the original alone.
		if (target.width === bitmap.width && target.height === bitmap.height && quality >= 1) {
			return null;
		}

		const canvas = document.createElement('canvas');
		canvas.width = target.width;
		canvas.height = target.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, target.width, target.height);

		const encoded = await canvasToArrayBuffer(canvas, quality);
		return encoded ? {data: encoded, ext: 'jpg'} : null;
	} catch (error) {
		console.warn('[Immich] Could not re-encode image, keeping the original bytes:', error);
		return null;
	} finally {
		// Large bitmaps are held outside the JS heap; twenty of them will
		// exhaust a phone before the collector notices.
		bitmap?.close?.();
	}
}

// ---- writing into the vault ----------------------------------------------

interface AttachmentTarget {
	path: string;
	existing: TFile | null;
}

// getAvailablePathForAttachment resolves the user's attachment folder, creates
// it, and dedupes the name. A deduped name means a file of the desired name is
// already there - and since the name carries the asset id, that file is this
// asset.
async function resolveAttachmentTarget(
	app: App, desiredName: string, sourcePath: string, reuse: boolean
): Promise<AttachmentTarget> {
	const available = normalizePath(await app.fileManager.getAvailablePathForAttachment(desiredName, sourcePath));
	const slash = available.lastIndexOf('/');
	const dir = slash === -1 ? '' : available.slice(0, slash);
	const chosenName = slash === -1 ? available : available.slice(slash + 1);

	// With reuse off, always take the deduped path Obsidian offered rather than
	// adopting the file that is already there.
	if (!reuse || chosenName === desiredName) {
		return {path: available, existing: null};
	}

	const desiredPath = normalizePath(dir ? dir + '/' + desiredName : desiredName);
	const existing = app.vault.getFileByPath(desiredPath);
	return existing ? {path: desiredPath, existing} : {path: available, existing: null};
}

async function writeAttachment(app: App, path: string, data: ArrayBuffer): Promise<TFile> {
	try {
		return await app.vault.createBinary(path, data);
	} catch (error) {
		// Recovery only. The adapter bypasses the vault index, so a file written
		// this way may not be linkable until the index catches up.
		console.warn('[Immich] createBinary failed, falling back to the adapter:', error);
		await app.vault.adapter.writeBinary(normalizePath(path), data);
		const file = app.vault.getFileByPath(path);
		if (file) return file;
		await new Promise(resolve => window.setTimeout(resolve, 50));
		const retried = app.vault.getFileByPath(path);
		if (retried) return retried;
		throw error;
	}
}

function embedMarkdown(app: App, file: TFile, sourcePath: string, embed: boolean): string {
	// generateMarkdownLink honours the user's wikilink/markdown and relative
	// path preferences; it has no embed flag, hence the manual '!'.
	const link = app.fileManager.generateMarkdownLink(file, sourcePath);
	return (embed ? '!' : '') + link + '\n';
}

// ---- the importer ---------------------------------------------------------

interface ImportOptions {
	size: RenditionSize;
	reencode: boolean;
	maxEdge: number;
	quality: number;
	reuseExisting: boolean;
	renditionFallback: boolean;
	downloadVideos: boolean;
}

interface ImportProgress {
	index: number;
	total: number;
	asset: ImmichAsset;
}

interface ImportResult {
	markdown: string;
	failed: number;
	downloaded: number;
	reused: number;
	cancelled: boolean;
	notes: string[];
}

// Stop trying after this many failures in a row: a wrong share key or a missing
// permission fails every asset, and there is no sense working through twenty of
// them to discover that.
const CONSECUTIVE_FAILURE_LIMIT = 3;

class AssetImporter {
	private app: App;
	private creds: ImmichCredentials;
	private sourcePath: string;
	private options: ImportOptions;
	private done = new Map<string, {file: TFile, embed: boolean}>();
	private cancelled = false;

	private firstError = '';
	private downgraded = 0;
	private fellBackToRendition = 0;
	private savedUnrenderable = 0;

	constructor(app: App, creds: ImmichCredentials, sourcePath: string, options: ImportOptions) {
		this.app = app;
		this.creds = creds;
		this.sourcePath = sourcePath;
		this.options = options;
	}

	cancel() {
		this.cancelled = true;
	}

	// Predicts the saved name without a request, so an asset already in the
	// vault can be reused before anything is downloaded. A wrong guess only
	// costs a download that would otherwise have been skipped.
	private predictedFileName(asset: ImmichAsset): string {
		const ext = this.options.size === 'original'
			? (splitFileName(asset.fileName).ext || 'jpg')
			: (asset.type === 'VIDEO' ? 'mp4' : 'jpg');
		return downloadFileName(asset, ext);
	}

	private async importOne(asset: ImmichAsset): Promise<string> {
		const cached = this.done.get(asset.id);
		if (cached) {
			return embedMarkdown(this.app, cached.file, this.sourcePath, cached.embed);
		}

		if (this.options.reuseExisting) {
			const probe = await resolveAttachmentTarget(this.app, this.predictedFileName(asset), this.sourcePath, true);
			if (probe.existing) {
				const embed = isRenderable(asset, splitFileName(probe.existing.name).ext);
				this.done.set(asset.id, {file: probe.existing, embed});
				return embedMarkdown(this.app, probe.existing, this.sourcePath, embed);
			}
		}

		let fetched = await fetchAssetBytes(this.creds, asset, this.options.size);
		if (fetched.sizeUsed !== this.options.size) this.downgraded++;

		let ext = extensionForDownload(asset, fetched.contentType, fetched.sizeUsed);

		// HEIC and camera RAW cannot be shown by Obsidian, and cannot be decoded
		// by the browser either - but Immich will transcode them for us.
		if (!isRenderable(asset, ext) && asset.type !== 'VIDEO' && this.options.renditionFallback
			&& fetched.sizeUsed === 'original') {
			try {
				fetched = await fetchAssetBytes(this.creds, asset, 'fullsize');
				ext = extensionForDownload(asset, fetched.contentType, fetched.sizeUsed);
				this.fellBackToRendition++;
			} catch (error) {
				console.warn('[Immich] Could not fetch a displayable rendition:', error);
			}
		}

		let data = fetched.data;
		if (this.options.reencode && asset.type !== 'VIDEO' && isRenderable(asset, ext)) {
			const reencoded = await reencodeImage(
				data, fetched.contentType, ext, this.options.maxEdge, this.options.quality
			);
			if (reencoded) {
				data = reencoded.data;
				ext = reencoded.ext;
			}
		}

		const embed = isRenderable(asset, ext);
		if (!embed) this.savedUnrenderable++;

		const target = await resolveAttachmentTarget(
			this.app, downloadFileName(asset, ext), this.sourcePath, this.options.reuseExisting
		);
		const file = target.existing ?? await writeAttachment(this.app, target.path, data);
		this.done.set(asset.id, {file, embed});
		return embedMarkdown(this.app, file, this.sourcePath, embed);
	}

	async importAll(
		assets: ImmichAsset[],
		onProgress: (progress: ImportProgress) => void,
		linkTextFor: (asset: ImmichAsset) => string
	): Promise<ImportResult> {
		const parts: string[] = [];
		let failed = 0;
		let downloaded = 0;
		let reused = 0;
		let consecutive = 0;
		let givenUp = false;

		for (let i = 0; i < assets.length; i++) {
			if (this.cancelled) {
				return {markdown: '', failed, downloaded, reused, cancelled: true, notes: []};
			}

			const asset = assets[i];
			onProgress({index: i + 1, total: assets.length, asset});

			// Videos are linked unless the user opted in; they are far larger
			// than photos and cannot be shrunk client-side.
			if (asset.type === 'VIDEO' && !this.options.downloadVideos) {
				parts.push(linkTextFor(asset));
				continue;
			}
			if (givenUp) {
				parts.push(linkTextFor(asset));
				continue;
			}

			try {
				const before = this.done.size;
				parts.push(await this.importOne(asset));
				if (this.done.size > before) downloaded++; else reused++;
				consecutive = 0;
			} catch (error) {
				console.error('[Immich] Failed to download ' + asset.fileName + ':', error);
				// Without the underlying reason the summary is unactionable.
				if (!this.firstError) this.firstError = describeException(error);
				// A working hot link in the right position beats a gap.
				parts.push(linkTextFor(asset));
				failed++;
				consecutive++;
				if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
					givenUp = true;
					console.warn('[Immich] Too many consecutive download failures; linking the rest.');
				}
			}
		}

		const notes: string[] = [];
		if (failed > 0) {
			notes.push(failed + (failed === 1 ? ' item' : ' items') + ' could not be downloaded and ' +
				(failed === 1 ? 'was' : 'were') + ' inserted as links.');
		}
		if (this.firstError) notes.push('First failure: ' + this.firstError);
		if (this.downgraded > 0) {
			notes.push(this.downgraded + ' could not be fetched at the requested size and used the medium rendition.');
		}
		if (this.fellBackToRendition > 0) {
			notes.push(this.fellBackToRendition + ' original' + (this.fellBackToRendition === 1 ? '' : 's') +
				' could not be displayed by Obsidian and ' + (this.fellBackToRendition === 1 ? 'was' : 'were') +
				' saved as a rendered image instead.');
		}
		if (this.savedUnrenderable > 0) {
			notes.push(this.savedUnrenderable + ' file' + (this.savedUnrenderable === 1 ? '' : 's') +
				' cannot be displayed by Obsidian and ' + (this.savedUnrenderable === 1 ? 'was' : 'were') +
				' inserted as a link rather than an embed.');
		}

		return {markdown: parts.join(''), failed, downloaded, reused, cancelled: false, notes};
	}
}

// ---- the video prompt -----------------------------------------------------

type VideoChoice = 'download' | 'link' | 'cancel';

// Hand-rolled rather than ConfirmationModal, which needs Obsidian 1.13 while
// this plugin supports 1.11.4.
class VideoPromptModal extends Modal {
	private count: number;
	private resolve: (choice: VideoChoice) => void;
	private settled = false;

	constructor(app: App, count: number, resolve: (choice: VideoChoice) => void) {
		super(app);
		this.count = count;
		this.resolve = resolve;
	}

	private settle(choice: VideoChoice) {
		if (this.settled) return;
		this.settled = true;
		this.resolve(choice);
	}

	onOpen() {
		const {contentEl, titleEl} = this;
		titleEl.setText('Download videos too?');
		contentEl.createEl('p', {
			text: 'Your selection includes ' + this.count + (this.count === 1 ? ' video' : ' videos') +
				'. Videos are saved at full size and can be very large - they cannot be shrunk the way ' +
				'photos can. Photos in this selection will be downloaded either way.'
		});

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('Link videos')
				.onClick(() => {
					this.settle('link');
					this.close();
				}))
			.addButton(button => button
				.setCta()
				.setButtonText('Download videos')
				.onClick(() => {
					this.settle('download');
					this.close();
				}))
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => {
					this.settle('cancel');
					this.close();
				}));
	}

	onClose() {
		// Covers Escape and clicking outside, so the promise always resolves.
		this.settle('cancel');
		this.contentEl.empty();
	}
}

function askAboutVideos(app: App, count: number): Promise<VideoChoice> {
	return new Promise(resolve => new VideoPromptModal(app, count, resolve).open());
}

type TypeFilter = 'ALL' | 'IMAGE' | 'VIDEO';

// How many tiles to append per chunk. The grid renders incrementally so that a
// large album does not build thousands of elements before first paint; an
// IntersectionObserver on a sentinel at the end of the grid pulls the next
// chunk in as the user approaches it.
const RENDER_CHUNK = 60;

class ImageSelectorModal extends Modal {
	editor: Editor;
	creds: ImmichCredentials;
	sourcePath: string;
	settings: PluginSettings;

	private assets: ImmichAsset[] = [];
	private visible: ImmichAsset[] = [];
	// Insertion order matters: assets are inserted in the order they were
	// picked, not the order they appear in the album.
	private selection: string[] = [];
	private query = '';
	private typeFilter: TypeFilter = 'ALL';
	private rendered = 0;
	// Non-null once a smart search has run: its ranked results stand in for the
	// album until the query is edited again.
	private smartResults: ImmichAsset[] | null = null;
	private smartQuery = '';
	private searching = false;

	private gridEl: HTMLElement | null = null;
	private sentinelEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private insertButtonEl: HTMLButtonElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private observer: IntersectionObserver | null = null;
	private searchDebounce: number | null = null;
	private modeEl: HTMLElement | null = null;
	private cancelButtonEl: HTMLButtonElement | null = null;
	// Per-insert override of settings.insertMode; deliberately not persisted.
	private insertMode: InsertMode = 'link';
	private importer: AssetImporter | null = null;
	private importing = false;

	constructor(app: App, editor: Editor, sourcePath: string, creds: ImmichCredentials, settings: PluginSettings) {
		super(app);
		this.editor = editor;
		this.sourcePath = sourcePath;
		this.creds = creds;
		this.settings = settings;
	}

	async onOpen() {
		const {contentEl, modalEl} = this;
		modalEl.addClass('obsidian-immich-modal');
		contentEl.addClass('obsidian-immich-picker');

		this.resetState();

		const loading = contentEl.createDiv({cls: 'obsidian-immich-empty'});
		loading.setText('Loading album…');

		if (cachedResult == null || cachedResult.fingerprint !== credentialsFingerprint(this.creds)) {
			try {
				await refreshCacheFromImmich(this.creds);
			} catch (error) {
				console.error('[Immich] Failed to load album:', error);
				loading.setText('Failed to load the immich album. ' + describeException(error));
				return;
			}
		}
		loading.remove();

		const cache = cachedResult;
		if (cache == null) return;
		// Drop anything the picker could not insert anyway, so that every count
		// it reports matches the number of tiles actually on screen.
		this.assets = cache.assets.filter(asset => this.isInsertable(asset));

		this.buildHeader(contentEl, cache.albumName);

		if (this.assets.length === 0) {
			contentEl.createDiv({cls: 'obsidian-immich-empty'}).setText(
				'This album has no assets. Add some in immich, then refresh.'
			);
			return;
		}

		this.buildToolbar(contentEl);
		this.buildGrid(contentEl);
		this.buildFooter(contentEl);
		this.applyFilter();
	}

	private resetState() {
		this.selection = [];
		this.query = '';
		this.typeFilter = 'ALL';
		this.rendered = 0;
		this.visible = [];
		this.smartResults = null;
		this.smartQuery = '';
		this.searching = false;
		this.insertMode = this.settings.insertMode;
		this.importing = false;
		this.importer = null;
	}

	private buildHeader(parent: HTMLElement, albumName: string) {
		const header = parent.createDiv({cls: 'obsidian-immich-header'});
		const titles = header.createDiv({cls: 'obsidian-immich-titles'});
		titles.createDiv({cls: 'obsidian-immich-title'}).setText(albumName || 'Immich album');
		this.statusEl = titles.createDiv({cls: 'obsidian-immich-subtitle'});

		const refresh = header.createEl('button', {cls: 'obsidian-immich-refresh'});
		refresh.setText('Refresh');
		refresh.setAttribute('aria-label', 'Reload the album from immich');
		refresh.onclick = async () => {
			refresh.disabled = true;
			refresh.setText('Refreshing…');
			try {
				await refreshCacheFromImmich(this.creds, false);
				this.onClose();
				await this.onOpen();
			} catch (error) {
				console.error('[Immich] Refresh failed:', error);
				new Notice('Failed to refresh cache. ' + describeException(error));
				refresh.disabled = false;
				refresh.setText('Refresh');
			}
		};
	}

	private buildToolbar(parent: HTMLElement) {
		const toolbar = parent.createDiv({cls: 'obsidian-immich-toolbar'});

		const search = toolbar.createEl('input', {
			cls: 'obsidian-immich-search',
			attr: {
				type: 'search',
				placeholder: 'Filter by name, place or date — press Enter to search by content',
				spellcheck: 'false'
			}
		});
		this.searchEl = search;
		search.addEventListener('input', () => {
			if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
			// Debounced so that typing does not rebuild the grid on every keystroke.
			this.searchDebounce = window.setTimeout(() => {
				this.query = search.value;
				// Editing the query drops back to instant local filtering; the
				// smart results no longer correspond to what is in the box.
				this.smartResults = null;
				this.smartQuery = '';
				this.applyFilter();
			}, 120);
		});
		search.addEventListener('keydown', (event: KeyboardEvent) => {
			// Escape clears the search before it closes the modal, so an
			// unwanted search does not cost the whole selection.
			if (event.key === 'Escape' && (this.smartResults !== null || search.value !== '')) {
				event.preventDefault();
				event.stopPropagation();
				search.value = '';
				this.query = '';
				this.smartResults = null;
				this.smartQuery = '';
				this.applyFilter();
				return;
			}
			if (event.key !== 'Enter') return;
			event.preventDefault();
			// Enter searches; the modifier inserts, so a search cannot be
			// mistaken for a commit into the note.
			if (event.metaKey || event.ctrlKey) {
				this.insertSelection();
			} else {
				this.runSmartSearch(search.value.trim());
			}
		});
		window.setTimeout(() => search.focus(), 0);

		const filters = toolbar.createDiv({cls: 'obsidian-immich-filters'});
		const options: Array<{key: TypeFilter, label: string}> = [
			{key: 'ALL', label: 'All'},
			{key: 'IMAGE', label: 'Photos'},
			{key: 'VIDEO', label: 'Videos'}
		];
		for (const option of options) {
			const button = filters.createEl('button', {cls: 'obsidian-immich-filter'});
			button.setText(option.label);
			button.toggleClass('is-active', this.typeFilter === option.key);
			button.onclick = () => {
				this.typeFilter = option.key;
				filters.findAll('.obsidian-immich-filter').forEach(el => el.removeClass('is-active'));
				button.addClass('is-active');
				this.applyFilter();
			};
		}
	}

	private buildGrid(parent: HTMLElement) {
		const scroller = parent.createDiv({cls: 'obsidian-immich-scroll'});
		this.gridEl = scroller.createDiv({cls: 'obsidian-immich-grid'});
		this.sentinelEl = scroller.createDiv({cls: 'obsidian-immich-sentinel'});

		this.observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting)) {
				this.renderChunk();
			}
		}, {root: scroller, rootMargin: '400px'});
		this.observer.observe(this.sentinelEl);
	}

	private buildFooter(parent: HTMLElement) {
		const footer = parent.createDiv({cls: 'obsidian-immich-footer'});

		// Per-insert override of the configured default, so one photo can be
		// downloaded without a trip to settings.
		this.modeEl = footer.createDiv({cls: 'obsidian-immich-mode'});
		const modes: Array<{key: InsertMode, label: string, hint: string}> = [
			{key: 'link', label: 'Link', hint: 'Insert a link to Immich - needs the server to stay online'},
			{key: 'download', label: 'Download', hint: 'Save a copy into the vault'}
		];
		for (const mode of modes) {
			const button = this.modeEl.createEl('button', {cls: 'obsidian-immich-mode-option'});
			button.setText(mode.label);
			button.setAttribute('aria-label', mode.hint);
			button.toggleClass('is-active', this.insertMode === mode.key);
			button.setAttribute('aria-pressed', String(this.insertMode === mode.key));
			button.onclick = () => {
				if (this.importing) return;
				this.insertMode = mode.key;
				this.modeEl?.findAll('.obsidian-immich-mode-option').forEach(el => {
					el.removeClass('is-active');
					el.setAttribute('aria-pressed', 'false');
				});
				button.addClass('is-active');
				button.setAttribute('aria-pressed', 'true');
				this.updateStatus();
			};
		}

		this.cancelButtonEl = footer.createEl('button', {cls: 'obsidian-immich-cancel'});
		this.cancelButtonEl.setText('Cancel');
		this.cancelButtonEl.onclick = () => this.importer?.cancel();

		const clear = footer.createEl('button', {cls: 'obsidian-immich-clear'});
		clear.setText('Clear selection');
		clear.onclick = () => {
			if (this.importing) return;
			this.selection = [];
			this.gridEl?.findAll('.obsidian-immich-tile').forEach(el => el.removeClass('is-selected'));
			this.updateStatus();
		};

		this.insertButtonEl = footer.createEl('button', {cls: 'mod-cta obsidian-immich-insert'});
		this.insertButtonEl.onclick = () => this.insertSelection();
	}

	private setImporting(importing: boolean) {
		this.importing = importing;
		this.contentEl.toggleClass('is-importing', importing);
		if (this.insertButtonEl) this.insertButtonEl.disabled = importing;
	}

	private showProgress(progress: ImportProgress) {
		if (!this.statusEl) return;
		this.statusEl.setText(
			'Downloading ' + progress.index + ' of ' + progress.total +
			(progress.asset.fileName ? ' · ' + progress.asset.fileName : '')
		);
		if (this.insertButtonEl) this.insertButtonEl.setText('Downloading…');
	}

	// Immich's smart search matches on what a photo shows, which no amount of
	// local filename matching can approximate - so it runs against the server.
	private async runSmartSearch(query: string) {
		if (this.searching) return;
		if (!query) {
			this.smartResults = null;
			this.smartQuery = '';
			this.applyFilter();
			return;
		}

		this.searching = true;
		this.updateStatus();
		try {
			const results = await smartSearch(this.creds, query, this.typeFilter);
			this.smartResults = results;
			this.smartQuery = query;
		} catch (error) {
			console.error('[Immich] Smart search failed:', error);
			new Notice('Smart search failed. ' + describeException(error));
			this.smartResults = null;
			this.smartQuery = '';
		} finally {
			this.searching = false;
			this.applyFilter();
		}
	}

	private applyFilter() {
		// In smart mode the server has already decided which assets match, and
		// its ranking is the point - so only the type filter is applied on top.
		const inSmartMode = this.smartResults !== null;
		const source = this.smartResults ?? this.assets;
		const tokens = inSmartMode ? [] : this.query.toLowerCase().split(/\s+/).filter(Boolean);

		this.visible = source.filter(asset =>
			(this.typeFilter === 'ALL' || asset.type === this.typeFilter) && matchesQuery(asset, tokens)
		);

		this.rendered = 0;
		if (this.gridEl) this.gridEl.empty();
		this.renderChunk();
		this.updateStatus();
	}

	private renderChunk() {
		const grid = this.gridEl;
		if (!grid || this.rendered >= this.visible.length) return;

		const end = Math.min(this.rendered + RENDER_CHUNK, this.visible.length);
		for (let i = this.rendered; i < end; i++) {
			this.renderTile(grid, this.visible[i]);
		}
		this.rendered = end;
	}

	private renderTile(grid: HTMLElement, asset: ImmichAsset) {
		// A div rather than a button: Obsidian's own button styling imposes a
		// control height that collapses the tile regardless of aspect-ratio.
		const tile = grid.createDiv({cls: 'obsidian-immich-tile'});
		const selected = this.selection.includes(asset.id);
		tile.toggleClass('is-selected', selected);
		tile.setAttribute('role', 'button');
		tile.setAttribute('tabindex', '0');
		tile.setAttribute('aria-pressed', String(selected));
		tile.setAttribute('aria-label', asset.fileName || 'Immich asset');

		const img = tile.createEl('img', {attr: {loading: 'lazy', decoding: 'async', alt: ''}});
		// Reserve the correct shape up front so the masonry columns do not jump
		// as thumbnails arrive. Immich's dimensions are a hint; the loaded image
		// is authoritative, which also sidesteps EXIF orientation differences.
		if (asset.width > 0 && asset.height > 0) {
			img.style.aspectRatio = asset.width + ' / ' + asset.height;
		}
		img.src = this.assetUrl(asset) + '/thumbnail?size=thumbnail&key=' + this.creds.immichAlbumKey;
		img.onload = () => {
			if (img.naturalWidth > 0 && img.naturalHeight > 0) {
				img.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
			}
		};
		img.onerror = () => {
			tile.addClass('is-broken');
			tile.setText('Failed to load');
		};

		if (asset.type === 'VIDEO') {
			tile.createDiv({cls: 'obsidian-immich-badge'}).setText('Video');
		}
		tile.createDiv({cls: 'obsidian-immich-check'}).setText('✓');

		const caption = tile.createDiv({cls: 'obsidian-immich-caption'});
		caption.setText(asset.fileName || asset.taken.slice(0, 10));
		caption.setAttribute('title', [asset.fileName, asset.place, asset.taken.slice(0, 10)]
			.filter(Boolean).join(' · '));

		const toggle = () => {
			const at = this.selection.indexOf(asset.id);
			if (at === -1) {
				this.selection.push(asset.id);
				tile.addClass('is-selected');
			} else {
				this.selection.splice(at, 1);
				tile.removeClass('is-selected');
			}
			tile.setAttribute('aria-pressed', String(at === -1));
			this.updateStatus();
		};

		tile.onclick = toggle;
		// The tile is not a real button, so it has to answer the keys one would.
		tile.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		});
	}

	private assetUrl(asset: ImmichAsset): string {
		return this.creds.immichUrl + '/api/assets/' + asset.id;
	}

	// A hot link back to Immich - the pre-0.7.0 behaviour, and the fallback
	// whenever a download fails.
	private linkTextFor(asset: ImmichAsset): string {
		const url = this.assetUrl(asset);
		const key = this.creds.immichAlbumKey;
		if (asset.type === 'VIDEO') {
			return '<video src="' + url + '/video/playback?key=' + key + '" controls></video>\n';
		}
		return '![](' + url + '/thumbnail?size=preview&key=' + key + ')\n';
	}

	private isInsertable(asset: ImmichAsset): boolean {
		return asset.type === 'IMAGE' || asset.type === 'VIDEO';
	}

	private updateStatus() {
		const total = this.assets.length;
		const shown = this.visible.length;
		const picked = this.selection.length;

		if (this.statusEl) {
			let scope: string;
			if (this.searching) {
				scope = 'Searching…';
			} else if (this.smartResults !== null) {
				// Say when the result set was capped rather than letting it look
				// like the album simply contains that many matches.
				const capped = this.smartResults.length >= SMART_SEARCH_LIMIT ? 'top ' : '';
				scope = capped + shown + ' result' + (shown === 1 ? '' : 's') +
					' for “' + this.smartQuery + '” · Esc to clear';
			} else {
				scope = shown === total
					? total + (total === 1 ? ' item' : ' items')
					: shown + ' of ' + total + ' items';
			}
			this.statusEl.setText(picked > 0 ? scope + ' · ' + picked + ' selected' : scope);
		}

		if (this.insertButtonEl && !this.importing) {
			this.insertButtonEl.disabled = picked === 0;
			const verb = this.insertMode === 'download' ? 'Download' : 'Insert';
			this.insertButtonEl.setText(picked > 1 ? verb + ' ' + picked + ' items' : verb);
		}

		// Distinguish "no results" from "empty album" - the fix differs.
		const existing = this.gridEl?.parentElement?.querySelector('.obsidian-immich-noresults');
		if (shown === 0 && !this.searching && !existing && this.gridEl?.parentElement) {
			this.gridEl.parentElement.createDiv({cls: 'obsidian-immich-noresults'}).setText(
				this.smartResults !== null
					? 'Immich found nothing in this album matching “' + this.smartQuery + '”.'
					: 'Nothing matches that filter. Press Enter to search by image content instead.'
			);
		} else if ((shown > 0 || this.searching) && existing) {
			existing.remove();
		}
	}

	private async insertSelection() {
		if (this.selection.length === 0 || this.importing) return;

		const byId = new Map(this.assets.map(asset => [asset.id, asset]));
		const chosen = this.selection
			.map(id => byId.get(id))
			.filter((asset): asset is ImmichAsset => asset !== undefined);
		if (chosen.length === 0) return;

		if (this.insertMode === 'link') {
			this.editor.replaceSelection(chosen.map(asset => this.linkTextFor(asset)).join(''));
			new Notice('Inserted ' + chosen.length + (chosen.length === 1 ? ' item' : ' items') + '.');
			this.close();
			return;
		}

		// Videos are far larger than photos and cannot be shrunk client-side, so
		// they are always an explicit choice. Asked before any network activity.
		let downloadVideos = false;
		const videos = chosen.filter(asset => asset.type === 'VIDEO').length;
		if (videos > 0) {
			const choice = await askAboutVideos(this.app, videos);
			if (choice === 'cancel') return;
			downloadVideos = choice === 'download';
		}

		// Captured now: downloads take time and the cursor may move meanwhile.
		// Writing the whole result once also keeps it to a single undo step.
		const from = this.editor.getCursor('from');
		const to = this.editor.getCursor('to');

		this.importer = new AssetImporter(this.app, this.creds, this.sourcePath, {
			size: this.settings.downloadSize,
			reencode: this.settings.reencode,
			maxEdge: this.settings.maxEdge,
			quality: this.settings.jpegQuality,
			reuseExisting: this.settings.reuseExistingDownloads,
			renditionFallback: this.settings.renditionFallback,
			downloadVideos: downloadVideos
		});
		this.setImporting(true);

		try {
			const result = await this.importer.importAll(
				chosen,
				progress => this.showProgress(progress),
				asset => this.linkTextFor(asset)
			);

			if (result.cancelled) {
				new Notice('Download cancelled. Nothing was inserted.');
				return;
			}

			this.editor.replaceRange(result.markdown, from, to);
			const summary = ['Inserted ' + chosen.length + (chosen.length === 1 ? ' item' : ' items') + '.']
				.concat(result.notes).join(' ');
			new Notice(summary, result.notes.length > 0 ? 12000 : 4000);
			this.close();
		} catch (error) {
			console.error('[Immich] Import failed:', error);
			new Notice('Failed to insert. ' + describeException(error));
		} finally {
			this.setImporting(false);
			this.importer = null;
			if (this.insertButtonEl) this.insertButtonEl.setText('Insert');
			this.updateStatus();
		}
	}

	onClose() {
		if (this.searchDebounce) {
			window.clearTimeout(this.searchDebounce);
			this.searchDebounce = null;
		}
		this.observer?.disconnect();
		this.observer = null;
		this.gridEl = null;
		this.sentinelEl = null;
		this.statusEl = null;
		this.insertButtonEl = null;
		this.searchEl = null;
		this.modeEl = null;
		this.cancelButtonEl = null;
		this.resetState();
		this.contentEl.empty();
	}
}

class SettingTab extends PluginSettingTab {
	plugin: ObsidianImmich;

	constructor(app: App, plugin: ObsidianImmich) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		this.displayMigrationNotice(containerEl);

		new Setting(containerEl)
			.setName('Immich URL')
			.setDesc('Full URL to your immich instance.')
			.addText(text => text
				.setValue(this.plugin.settings.immichUrl)
				.onChange(async (value) => {
					this.plugin.settings.immichUrl = normalizeImmichUrl(value);
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich API key')
			.setDesc('Stored in Obsidian\'s keychain. Obtained from {IMMICH_URL}/user-settings?isOpen=api-keys.')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.immichApiKeySecret)
				.onChange(async (secretId) => {
					this.plugin.settings.immichApiKeySecret = secretId ?? '';
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich album ID')
			.setDesc('UUID for the `obsidian` album in immich.')
			.addText(text => text
				.setValue(this.plugin.settings.immichAlbum)
				.onChange(async (value) => {
					this.plugin.settings.immichAlbum = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich album share key')
			.setDesc('Stored in Obsidian\'s keychain. Share key which shows up in the URL of your album.')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.immichAlbumKeySecret)
				.onChange(async (secretId) => {
					this.plugin.settings.immichAlbumKeySecret = secretId ?? '';
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl).setName('Downloads').setHeading();

		new Setting(containerEl)
			.setName('Insert photos as')
			.setDesc('The picker has a Link/Download toggle that overrides this for a single insert.')
			.addDropdown(dropdown => dropdown
				.addOption('link', 'A link to Immich (needs the server online)')
				.addOption('download', 'A copy downloaded into the vault')
				.setValue(this.plugin.settings.insertMode)
				.onChange(async (value) => {
					this.plugin.settings.insertMode = value as InsertMode;
					await this.plugin.saveSettings();
				}));

		const sizeSetting = new Setting(containerEl)
			.setName('Downloaded size')
			.addDropdown(dropdown => dropdown
				.addOption('original', 'Original (largest, as uploaded)')
				.addOption('fullsize', 'Large')
				.addOption('preview', 'Medium (recommended)')
				.addOption('thumbnail', 'Small')
				.setValue(this.plugin.settings.downloadSize)
				.onChange(async (value) => {
					this.plugin.settings.downloadSize = value as RenditionSize;
					await this.plugin.saveSettings();
					// The warning and the fallback row below depend on this.
					this.display();
				}));
		sizeSetting.setDesc(this.plugin.settings.downloadSize === 'original'
			? 'Originals from phones are often HEIC, which Obsidian cannot display. Original and Large ' +
				'also require the album share link to allow downloads.'
			: 'Medium and Small are rendered by Immich, so they are always a format Obsidian can display.');

		if (this.plugin.settings.downloadSize === 'original') {
			new Setting(containerEl)
				.setName('Fall back to a rendered image')
				.setDesc('When an original cannot be displayed by Obsidian (HEIC, RAW), download Immich\'s ' +
					'rendered version instead. With this off, such files are saved as-is and inserted as ' +
					'links rather than embedded images.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.renditionFallback)
					.onChange(async (value) => {
						this.plugin.settings.renditionFallback = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Shrink images after downloading')
			.setDesc('Re-compresses images inside Obsidian. Strips EXIF metadata, including dates and ' +
				'location. Never applied to GIFs or SVGs.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.reencode)
				.onChange(async (value) => {
					this.plugin.settings.reencode = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.reencode) {
			new Setting(containerEl)
				.setName('Maximum edge')
				.setDesc('Longest side in pixels. Larger images are scaled down; smaller ones are left alone.')
				.addSlider(slider => slider
					.setLimits(256, 8192, 128)
					.setValue(this.plugin.settings.maxEdge)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxEdge = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('JPEG quality')
				.setDesc('Lower means smaller files and more visible compression.')
				.addSlider(slider => slider
					.setLimits(30, 100, 5)
					.setValue(Math.round(this.plugin.settings.jpegQuality * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.jpegQuality = value / 100;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Reuse existing downloads')
			.setDesc('If a photo has already been downloaded into this vault, link the existing file ' +
				'instead of downloading it again. Detected by the asset id in the filename, so renaming ' +
				'a downloaded file will cause it to be fetched again.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.reuseExistingDownloads)
				.onChange(async (value) => {
					this.plugin.settings.reuseExistingDownloads = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Validate the connection between obsidian and your immich instance.')
			.addButton((button) => {
				button.setButtonText("Test connection")
				button.onClick(async() => {
					testConnection(this.plugin.credentials())
				})
			})
	}

	// Shown only while pre-0.4.0 plaintext credentials are still in data.json.
	// Migration is opt-in, so nothing moves until the button is pressed.
	private displayMigrationNotice(containerEl: HTMLElement) {
		if (!hasLegacyPlaintextSecrets(this.plugin.settings)) {
			return;
		}

		const notice = containerEl.createDiv({cls: 'obsidian-immich-migration-notice'});
		notice.createEl('p', {
			text: 'Your Immich credentials are currently stored as plaintext in this vault\'s ' +
				'data.json. Move them into Obsidian\'s keychain, where they are encrypted by ' +
				'your operating system, and the plaintext copies will be removed.'
		});

		new Setting(notice)
			.setName('Move credentials to the keychain')
			.setDesc('Creates keychain entries for the credentials found in data.json.')
			.addButton((button) => {
				button.setCta();
				button.setButtonText('Move to keychain');
				button.onClick(async () => {
					button.setDisabled(true);
					try {
						const migrated = await this.plugin.migrateLegacySecrets();
						new Notice('Moved ' + migrated.length + ' credential(s) into the keychain: ' + migrated.join(', '));
						this.display();
					} catch (error) {
						console.error('[Immich] Failed to migrate credentials:', error);
						new Notice('Failed to move credentials into the keychain - check the console for additional information.');
						button.setDisabled(false);
					}
				});
			});
	}
}
