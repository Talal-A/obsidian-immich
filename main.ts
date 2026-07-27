import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, RequestUrlParam, RequestUrlResponse, SecretComponent, Setting, requestUrl } from 'obsidian';

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
}

const DEFAULT_SETTINGS: PluginSettings = {
	immichUrl: '',
	immichAlbum: '',
	immichApiKeySecret: '',
	immichAlbumKeySecret: ''
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
type AuthKind = 'api-key' | 'share-key';

function describeHttpFailure(status: number, context: string, auth: AuthKind): string {
	switch (status) {
		case 401:
			return auth === 'share-key'
				? 'Immich rejected the album share key (401) while ' + context + '. Check it in the plugin ' +
					'settings - it should be only the key from the end of the share URL, not the whole URL.'
				: 'Immich rejected the API key (401) while ' + context + '. Check the API key in the plugin settings.';
		case 403:
			return auth === 'share-key'
				? 'Immich denied access (403) while ' + context + '. The album share link may have expired, or ' +
					'the album share key may be wrong.'
				: 'Immich denied access (403) while ' + context + '. The API key is most likely missing a ' +
					'required permission - this plugin needs ' + REQUIRED_PERMISSIONS + '.';
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
		return inlined as ImmichAsset[];
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
				size: pageSize
			})
		}, 'listing the album\'s assets');

		const searchAssets = result.json?.['assets'];
		const items: ImmichAsset[] = searchAssets?.['items'] ?? [];
		assets.push(...items);

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
			editorCallback: (editor: Editor) => {
				new ImageSelectorModal(this.app, editor, this.credentials()).open();
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

class ImageSelectorModal extends Modal {
	editor: Editor;
	creds: ImmichCredentials;
	currentPage: number;
	batchSize: number;
	loadedAssets: Map<number, HTMLElement>;
	scrollContainer: HTMLElement | null;
	isLoading: boolean;
	scrollTimeout: number | null;

	constructor(app: App, editor: Editor, creds: ImmichCredentials) {
		super(app);
		this.editor = editor;
		this.creds = creds;
		this.currentPage = 0;
		this.batchSize = 6;
		this.loadedAssets = new Map();
		this.scrollContainer = null;
		this.isLoading = false;
		this.scrollTimeout = null;
	}

	async onOpen() {
		const {contentEl} = this;

		// Reset paging state so that reopening after a refresh starts from the
		// top of the album rather than resuming an old scroll position.
		this.currentPage = 0;
		this.isLoading = false;
		this.loadedAssets.clear();

		if (cachedResult == null || cachedResult.fingerprint !== credentialsFingerprint(this.creds)) {
			try {
				await refreshCacheFromImmich(this.creds);
			} catch (error) {
				console.error('[Immich] Failed to load album:', error);
				contentEl.createDiv({cls: 'obsidian-immich-empty'}).setText(
					'Failed to load the immich album. ' + describeException(error)
				);
				return;
			}
		}

		const cache = cachedResult;
		if (cache == null) {
			return;
		}

		// Create header with title and refresh button
		const header = contentEl.createDiv({cls: 'obsidian-immich-header'});

		const titleDiv = header.createDiv({cls: 'obsidian-immich-title'});
		titleDiv.setText('Insert from album: ' + (cache.albumName || 'Select Image'));

		const refreshButton = header.createEl('button', {
			text: '\u21bb',
			cls: 'obsidian-immich-refresh-button'
		});
		refreshButton.onclick = async () => {
			refreshButton.disabled = true;
			refreshButton.setText('Loading...');
			try {
				await refreshCacheFromImmich(this.creds, false);
				// Reload the modal
				this.onClose();
				await this.onOpen();
			} catch (error) {
				new Notice('Failed to refresh cache. ' + describeException(error));
				console.error('Refresh failed:', error);
				refreshButton.disabled = false;
				refreshButton.setText('\u21bb Refresh');
			}
		};

		const totalAssets = cache.assets.length;

		if (totalAssets === 0) {
			contentEl.createDiv({cls: 'obsidian-immich-empty'}).setText(
				'This album has no assets. Add images to it in immich, then refresh.'
			);
			return;
		}

		// Create scroll container
		this.scrollContainer = contentEl.createDiv({cls: 'obsidian-immich-scroll-container'});
		this.scrollContainer.setAttribute('data-immich-modal-content', 'true');

		const row = this.scrollContainer.createDiv({cls: 'obsidian-immich-row'});
		const leftImageDiv = row.createDiv({cls: 'obsidian-immich-column'});
		const rightImageDiv = row.createDiv({cls: 'obsidian-immich-column'});
		const left = leftImageDiv.createDiv({cls: 'obsidian-immich-column-content'});
		const right = rightImageDiv.createDiv({cls: 'obsidian-immich-column-content'});

		// Create loading indicator inside scroll container
		const loadingDiv = this.scrollContainer.createDiv({cls: 'obsidian-immich-loading'});
		loadingDiv.setText('Loading images...');
		loadingDiv.style.display = 'none';

		// Setup scroll listener with throttling
		this.setupScrollListener(left, right, totalAssets, loadingDiv);

		// Initial load: load more items to ensure scrollbar appears on large screens
		const initialBatchSize = Math.max(this.batchSize * 3, 20); // Load at least 20 items initially
		this.loadBatch(left, right, 0, Math.min(initialBatchSize, totalAssets), loadingDiv, totalAssets);
	}

	private setupScrollListener(left: HTMLElement, right: HTMLElement, totalAssets: number, loadingDiv: HTMLElement) {
		if (!this.scrollContainer) return;

		this.scrollContainer.addEventListener('scroll', () => {
			if (this.scrollTimeout) {
				clearTimeout(this.scrollTimeout);
			}

			this.scrollTimeout = window.setTimeout(() => {
				this.checkAndLoadMore(left, right, totalAssets, loadingDiv);
			}, 150); // Throttle to 150ms
		});
	}

	private checkAndLoadMore(left: HTMLElement, right: HTMLElement, totalAssets: number, loadingDiv: HTMLElement) {
		if (!this.scrollContainer || this.isLoading || this.currentPage >= totalAssets) {
			return;
		}

		const scrollTop = this.scrollContainer.scrollTop;
		const scrollHeight = this.scrollContainer.scrollHeight;
		const clientHeight = this.scrollContainer.clientHeight;
		const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

		// Load more when user scrolls past 60% or when near bottom
		if (scrollPercentage > 0.6 || (scrollHeight - (scrollTop + clientHeight) < 300)) {
			const endIndex = Math.min(this.currentPage + this.batchSize, totalAssets);
			this.loadBatch(left, right, this.currentPage, endIndex, loadingDiv, totalAssets);
		}
	}

	private loadBatch(left: HTMLElement, right: HTMLElement, startIndex: number, endIndex: number, loadingDiv: HTMLElement, totalAssets: number) {
		if (this.isLoading || startIndex >= totalAssets) return;

		const assets = cachedResult?.assets;
		if (!assets) return;

		this.isLoading = true;
		loadingDiv.style.display = 'block';

		for (let i = startIndex; i < endIndex; i++) {
			if (this.loadedAssets.has(i)) continue;

			const asset = assets[i];
			const assetUrl = this.creds.immichUrl + '/api/assets/' + asset['id'];
			const keyParam = '&key=' + this.creds.immichAlbumKey;
			const thumbUrl = assetUrl + '/thumbnail?size=thumbnail' + keyParam;

			let insertionText: string;
			if (asset['type'] === "IMAGE") {
				insertionText = '![](' + assetUrl + '/thumbnail?size=preview' + keyParam + ')\n';
			} else if (asset['type'] === "VIDEO") {
				insertionText = '<video src="' + assetUrl + '/video/playback?key=' + this.creds.immichAlbumKey + '" controls></video>\n';
			} else {
				// Unknown asset type - nothing sensible to insert, so skip it
				// rather than rendering a tile that inserts `undefined`.
				continue;
			}

			const targetColumn = (i & 1) ? right : left;
			const overallDiv = targetColumn.createDiv({cls: 'obsidian-immich-overallDiv'});

			const imgElement = overallDiv.createEl("img");
			imgElement.src = thumbUrl;

			imgElement.onclick = () => {
				this.editor.replaceSelection(insertionText);
				overallDiv.setCssStyles({opacity: '0.5'});
			};

			imgElement.onerror = () => {
				overallDiv.setText('Failed to load');
			};

			this.loadedAssets.set(i, overallDiv);
		}

		this.currentPage = endIndex;

		setTimeout(() => {
			this.isLoading = false;
			if (endIndex >= totalAssets) {
				loadingDiv.style.display = 'none';
			}
		}, 100);
	}

	onClose() {
		if (this.scrollTimeout) {
			clearTimeout(this.scrollTimeout);
			this.scrollTimeout = null;
		}
		this.loadedAssets.clear();
		this.scrollContainer = null;
		this.currentPage = 0;
		this.isLoading = false;
		const {contentEl} = this;
		contentEl.empty();
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
