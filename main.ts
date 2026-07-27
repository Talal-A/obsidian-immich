import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, RequestUrlResponse, Setting, requestUrl } from 'obsidian';

interface PluginSettings {
	immichUrl: string;
	immichApiKey: string;
	immichAlbum: string;
	immichAlbumKey: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	immichUrl: '',
	immichApiKey: '',
	immichAlbum: '',
	immichAlbumKey: ''
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

// Identifies the settings the cache was built from, so that changing the
// instance/album/credentials invalidates it instead of showing stale assets.
function settingsFingerprint(settings: PluginSettings): string {
	return JSON.stringify([settings.immichUrl, settings.immichAlbum, settings.immichApiKey, settings.immichAlbumKey]);
}

function apiHeaders(settings: PluginSettings): Record<string, string> {
	return {
		'Accept': 'application/json',
		'x-api-key': settings.immichApiKey.toString()
	};
}

async function testConnection(settings: PluginSettings) {
	const url = new URL(settings.immichUrl + '/api/server/about');
	console.log('[Immich] Testing connection to:', url.toString());
	console.log('[Immich] API key configured:', settings.immichApiKey ? '✓ (present)' : '✗ (missing)');
	
	new Notice("Testing connection to " + url);
	try {
		const startTime = Date.now();
		const result = await requestUrl({
			url: url.toString(),
			headers: apiHeaders(settings)
		})
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
				immichUrl: settings.immichUrl,
				hasApiKey: !!settings.immichApiKey
			}
		});
		new Notice("Failed to connect to " + settings.immichUrl + " - check the console for additional information.")
	}	
	const url2 = new URL(settings.immichUrl + '/api/albums/' + settings.immichAlbum);
	console.log('[Immich] Testing album access with URL:', url2.toString());
	let albumResult: RequestUrlResponse | null = null;
	try {
		const startTime = Date.now();
		const result = await requestUrl({
			url: url2.toString(),
			headers: apiHeaders(settings)
		})
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
				immichUrl: settings.immichUrl,
				hasApiKey: !!settings.immichApiKey,
				albumId: settings.immichAlbum
			}
		});
		new Notice("Failed to access album - check the console for additional information.")
	}
	// If there is an item in the album, also test access to the first asset to verify that the album key is correct.
	// Immich v3 no longer inlines the assets in the album response, so look them up separately when needed.
	let firstAsset: ImmichAsset | null = null;
	if (albumResult) {
		try {
			const assets = await fetchAlbumAssets(settings, albumResult.json ?? {});
			firstAsset = assets[0] ?? null;
			if (assets.length === 0) {
				console.log('[Immich] Album contains no assets - skipping asset access test.');
			}
		} catch (exception) {
			console.error('[Immich] Failed to list album assets:', exception);
			new Notice("Failed to list album assets - check the console for additional information.");
		}
	}
	if (firstAsset) {
		const assetId = firstAsset['id'];
		const url3 = new URL(settings.immichUrl + '/api/assets/' + assetId + '/thumbnail?size=thumbnail&key=' + settings.immichAlbumKey);
		console.log('[Immich] Testing asset access with URL:', url3.toString());
		try {
			const startTime = Date.now();
			const result = await requestUrl({
				url: url3.toString(),
				headers: apiHeaders(settings)
			})
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
					immichUrl: settings.immichUrl,
					hasApiKey: !!settings.immichApiKey,
					albumId: settings.immichAlbum,
					albumKey: settings.immichAlbumKey
				}
			});
			new Notice("Failed to access asset - check the console for additional information. This may indicate an issue with the album key.");
		}
	}
}

// Immich v3 removed the `assets` array from the album response, so the assets
// have to be fetched separately via the search API. Older servers still inline
// them, so use those when present to avoid an extra round trip.
async function fetchAlbumAssets(settings: PluginSettings, album: Record<string, unknown>): Promise<ImmichAsset[]> {
	const inlined = album['assets'];
	if (Array.isArray(inlined)) {
		return inlined as ImmichAsset[];
	}

	const url = new URL(settings.immichUrl + '/api/search/metadata');
	const order = album['order'] === 'asc' ? 'asc' : 'desc';
	const pageSize = 1000; // Maximum permitted by the search API.
	const assets: ImmichAsset[] = [];
	let page = 1;

	// The search API is paginated and reports the next page to request, if any.
	while (page > 0) {
		const result = await requestUrl({
			url: url.toString(),
			method: 'POST',
			headers: { ...apiHeaders(settings), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				albumIds: [settings.immichAlbum],
				order: order,
				page: page,
				size: pageSize
			})
		});
		if (result.status !== 200) {
			throw new Error('Search API returned status ' + result.status);
		}

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

async function refreshCacheFromImmich(settings: PluginSettings, silent=true) {
	const url = new URL(settings.immichUrl + '/api/albums/' + settings.immichAlbum);
	const result = await requestUrl({
		url: url.toString(),
		headers: apiHeaders(settings)
	})
	if (result.status !== 200) {
		throw new Error('Album request returned status ' + result.status);
	}

	const album = result.json ?? {};
	const assets = await fetchAlbumAssets(settings, album);

	cachedResult = {
		albumName: album['albumName'] ?? '',
		assets: assets,
		fingerprint: settingsFingerprint(settings)
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
				new ImageSelectorModal(this.app, editor, this.settings).open();
			}
		});
 
		this.addCommand({
			id: 'force-refresh-album-cache',
			name: 'Refresh album cache',
			callback: () => {
				new Notice('Refreshing immich cache.');
				refreshCacheFromImmich(this.settings, false).catch((error) => {
					console.error('[Immich] Failed to refresh album cache:', error);
					new Notice('Failed to refresh the immich album cache - check the console for additional information.');
				});
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.immichUrl = normalizeImmichUrl(this.settings.immichUrl);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ImageSelectorModal extends Modal {
	editor: Editor;
	settings: PluginSettings;
	currentPage: number;
	batchSize: number;
	loadedAssets: Map<number, HTMLElement>;
	scrollContainer: HTMLElement | null;
	isLoading: boolean;
	scrollTimeout: number | null;

	constructor(app: App, editor: Editor, settings: PluginSettings) {
		super(app);
		this.editor = editor;
		this.settings = settings;
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

		if (cachedResult == null || cachedResult.fingerprint !== settingsFingerprint(this.settings)) {
			try {
				await refreshCacheFromImmich(this.settings);
			} catch (error) {
				console.error('[Immich] Failed to load album:', error);
				contentEl.createDiv({cls: 'obsidian-immich-empty'}).setText(
					'Failed to load the immich album. Check your settings and the console for additional information.'
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
				await refreshCacheFromImmich(this.settings, false);
				// Reload the modal
				this.onClose();
				await this.onOpen();
			} catch (error) {
				new Notice('Failed to refresh cache');
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
			const assetUrl = this.settings.immichUrl + '/api/assets/' + asset['id'];
			const keyParam = '&key=' + this.settings.immichAlbumKey;
			const thumbUrl = assetUrl + '/thumbnail?size=thumbnail' + keyParam;

			let insertionText: string;
			if (asset['type'] === "IMAGE") {
				insertionText = '![](' + assetUrl + '/thumbnail?size=preview' + keyParam + ')\n';
			} else if (asset['type'] === "VIDEO") {
				insertionText = '<video src="' + assetUrl + '/video/playback?key=' + this.settings.immichAlbumKey + '" controls></video>\n';
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
			.setDesc('Obtained from {IMMICH_URL}/user-settings?isOpen=api-keys.')
			.addText(text => text
				.setValue(this.plugin.settings.immichApiKey)
				.onChange(async (value) => {
					this.plugin.settings.immichApiKey = value;
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
			.setDesc('Share key which shows up in the URL of your album.')
			.addText(text => text
				.setValue(this.plugin.settings.immichAlbumKey)
				.onChange(async (value) => {
					this.plugin.settings.immichAlbumKey = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Validate the connection between obsidian and your immich instance.')
			.addButton(async (button) => {
				button.setButtonText("Test connection")
				button.onClick(async() => {
					testConnection(this.plugin.settings)
				})
			})
	}
}
