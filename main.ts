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
	fileName: string;
	// ISO timestamp, kept as the raw string - only ever shown as a date and
	// matched as text, so there is no reason to parse it.
	taken: string;
	place: string;
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
		place: place
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

// This one setting decides where the API key gets sent, and the value is also
// used as an <img> src and written into the user's notes, so anything that is
// not a plain http(s) origin is rejected rather than carried through to those
// sinks. Returns the problem to show the user, or null when the URL is usable.
function immichUrlProblem(value: string): string | null {
	if (!value) {
		return 'The Immich URL is not set.';
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// Left unparsed this surfaces later as a bare TypeError from whichever
		// request happened to be built first.
		return 'The Immich URL is not a valid URL. It should look like https://immich.example.com.';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'The Immich URL must start with http:// or https://.';
	}
	return null;
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

// Asset URLs carry the album share key in their query string, so anything that
// reaches the user - a Notice, a console line, a message they paste into an
// issue - has to have the query stripped off first.
function withoutQuery(url: string): string {
	const at = url.indexOf('?');
	return at === -1 ? url : url.slice(0, at);
}

// Videos are inserted as an HTML tag, so anything interpolated into an
// attribute has to be unable to close it.
function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Walks the three credentials in the order they are needed, so a failure points
// at the one setting that is actually wrong: the URL and API key have to work
// before the album ID is meaningful, and the album has to load before the share
// key can be tried against an asset. Everything is reported through Notice -
// requestUrl's status codes are already translated into actionable text by
// describeHttpFailure, so there is nothing useful left for the console.
async function testConnection(creds: ImmichCredentials) {
	const urlProblem = immichUrlProblem(creds.immichUrl);
	if (urlProblem) {
		new Notice(urlProblem);
		return;
	}

	const url = new URL(creds.immichUrl + '/api/server/about');
	new Notice("Testing connection to " + url.toString());
	try {
		await immichRequest({
			url: url.toString(),
			headers: apiHeaders(creds)
		}, 'contacting the server')
		new Notice("Connection successful")
	} catch(exception) {
		new Notice("Failed to connect to " + creds.immichUrl + ". " + describeException(exception))
	}

	const url2 = new URL(creds.immichUrl + '/api/albums/' + creds.immichAlbum);
	let albumResult: RequestUrlResponse | null = null;
	try {
		albumResult = await immichRequest({
			url: url2.toString(),
			headers: apiHeaders(creds)
		}, 'loading the album')
		new Notice("Album access successful - found " + albumResult.json['assetCount'] + " assets.");
	} catch(exception) {
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
				new Notice("Album is empty - skipping the album share key check.");
			}
		} catch (exception) {
			new Notice("Failed to list album assets. " + describeException(exception));
		}
	}
	if (firstAsset) {
		const url3 = new URL(creds.immichUrl + '/api/assets/' + firstAsset.id +
			'/thumbnail?size=thumbnail&key=' + creds.immichAlbumKey);
		try {
			await immichRequest({
				url: url3.toString(),
				headers: apiHeaders(creds)
			}, 'reading an asset thumbnail', 'share-key')
			new Notice("Asset access successful - album key is correct.");
		} catch(exception) {
			new Notice("Failed to access " + withoutQuery(url3.toString()) + ". " + describeException(exception) +
				" This may also indicate an issue with the album share key.");
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

async function refreshCacheFromImmich(creds: ImmichCredentials, silent=true) {
	// A missing secret usually means the keychain entry was deleted or renamed,
	// which is worth saying plainly rather than sending an unauthenticated call.
	const urlProblem = immichUrlProblem(creds.immichUrl);
	if (urlProblem) {
		throw new Error(urlProblem);
	}
	if (!creds.immichAlbum || !creds.immichApiKey) {
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

type TypeFilter = 'ALL' | 'IMAGE' | 'VIDEO';

// How many tiles to append per chunk. The grid renders incrementally so that a
// large album does not build thousands of elements before first paint; an
// IntersectionObserver on a sentinel at the end of the grid pulls the next
// chunk in as the user approaches it.
const RENDER_CHUNK = 60;

class ImageSelectorModal extends Modal {
	editor: Editor;
	creds: ImmichCredentials;

	private assets: ImmichAsset[] = [];
	private visible: ImmichAsset[] = [];
	// Insertion order matters: assets are inserted in the order they were
	// picked, not the order they appear in the album.
	private selection: string[] = [];
	private query = '';
	private typeFilter: TypeFilter = 'ALL';
	private rendered = 0;

	private gridEl: HTMLElement | null = null;
	private sentinelEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private insertButtonEl: HTMLButtonElement | null = null;
	private observer: IntersectionObserver | null = null;
	private searchDebounce: number | null = null;

	constructor(app: App, editor: Editor, creds: ImmichCredentials) {
		super(app);
		this.editor = editor;
		this.creds = creds;
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
				loading.setText('Failed to load the immich album. ' + describeException(error));
				return;
			}
		}
		loading.remove();

		const cache = cachedResult;
		if (cache == null) return;
		// Drop anything the picker could not insert anyway, so that every count
		// it reports matches the number of tiles actually on screen.
		this.assets = cache.assets.filter(asset => this.insertionTextFor(asset) !== null);

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
			attr: {type: 'search', placeholder: 'Search by name, place, or date…', spellcheck: 'false'}
		});
		search.addEventListener('input', () => {
			if (this.searchDebounce) activeWindow.clearTimeout(this.searchDebounce);
			// Debounced so that typing does not rebuild the grid on every keystroke.
			this.searchDebounce = activeWindow.setTimeout(() => {
				this.query = search.value;
				this.applyFilter();
			}, 120);
		});
		// Let the user go straight from typing to inserting.
		search.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && this.selection.length > 0) {
				event.preventDefault();
				this.insertSelection();
			}
		});
		activeWindow.setTimeout(() => search.focus(), 0);

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

		const clear = footer.createEl('button', {cls: 'obsidian-immich-clear'});
		clear.setText('Clear selection');
		clear.onclick = () => {
			this.selection = [];
			this.gridEl?.findAll('.obsidian-immich-tile').forEach(el => el.removeClass('is-selected'));
			this.updateStatus();
		};

		this.insertButtonEl = footer.createEl('button', {cls: 'mod-cta obsidian-immich-insert'});
		this.insertButtonEl.onclick = () => this.insertSelection();
	}

	private applyFilter() {
		const tokens = this.query.toLowerCase().split(/\s+/).filter(Boolean);
		this.visible = this.assets.filter(asset =>
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
		const insertionText = this.insertionTextFor(asset);
		// Nothing sensible to insert for an unknown media type, so leave it out
		// rather than offering a tile that does nothing.
		if (insertionText === null) return;

		const tile = grid.createEl('button', {cls: 'obsidian-immich-tile'});
		tile.setAttribute('type', 'button');
		tile.toggleClass('is-selected', this.selection.includes(asset.id));
		tile.setAttribute('aria-label', asset.fileName || 'Immich asset');

		const img = tile.createEl('img', {attr: {loading: 'lazy', decoding: 'async', alt: ''}});
		img.src = this.assetUrl(asset) + '/thumbnail?size=thumbnail&key=' + this.creds.immichAlbumKey;
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

		tile.onclick = () => {
			const at = this.selection.indexOf(asset.id);
			if (at === -1) {
				this.selection.push(asset.id);
				tile.addClass('is-selected');
			} else {
				this.selection.splice(at, 1);
				tile.removeClass('is-selected');
			}
			this.updateStatus();
		};
	}

	private assetUrl(asset: ImmichAsset): string {
		return this.creds.immichUrl + '/api/assets/' + asset.id;
	}

	private insertionTextFor(asset: ImmichAsset): string | null {
		const url = this.assetUrl(asset);
		// Escaped rather than trusted: both halves come from settings the user
		// pasted into, and the result is written into a note where a stray quote
		// would add attributes to the <video> tag and a stray bracket would end
		// the markdown link early.
		const key = encodeURIComponent(this.creds.immichAlbumKey);
		if (asset.type === 'IMAGE') {
			// Angle brackets keep any parenthesis in the URL inside the link.
			return '![](<' + url + '/thumbnail?size=preview&key=' + key + '>)\n';
		}
		if (asset.type === 'VIDEO') {
			return '<video src="' + escapeAttribute(url + '/video/playback?key=' + key) + '" controls></video>\n';
		}
		return null;
	}

	private updateStatus() {
		const total = this.assets.length;
		const shown = this.visible.length;
		const picked = this.selection.length;

		if (this.statusEl) {
			const scope = shown === total
				? total + (total === 1 ? ' item' : ' items')
				: shown + ' of ' + total + ' items';
			this.statusEl.setText(picked > 0 ? scope + ' · ' + picked + ' selected' : scope);
		}

		if (this.insertButtonEl) {
			this.insertButtonEl.disabled = picked === 0;
			this.insertButtonEl.setText(picked > 1 ? 'Insert ' + picked + ' items' : 'Insert');
		}

		// Distinguish "no results" from "empty album" - the fix differs.
		const existing = this.gridEl?.parentElement?.querySelector('.obsidian-immich-noresults');
		if (shown === 0 && !existing && this.gridEl?.parentElement) {
			this.gridEl.parentElement.createDiv({cls: 'obsidian-immich-noresults'})
				.setText('Nothing matches that search.');
		} else if (shown > 0 && existing) {
			existing.remove();
		}
	}

	private insertSelection() {
		if (this.selection.length === 0) return;

		const byId = new Map(this.assets.map(asset => [asset.id, asset]));
		const text = this.selection
			.map(id => byId.get(id))
			.map(asset => asset ? this.insertionTextFor(asset) : null)
			.filter((value): value is string => value !== null)
			.join('');

		if (text) {
			this.editor.replaceSelection(text);
			new Notice('Inserted ' + this.selection.length + (this.selection.length === 1 ? ' item' : ' items') + '.');
		}
		this.close();
	}

	onClose() {
		if (this.searchDebounce) {
			activeWindow.clearTimeout(this.searchDebounce);
			this.searchDebounce = null;
		}
		this.observer?.disconnect();
		this.observer = null;
		this.gridEl = null;
		this.sentinelEl = null;
		this.statusEl = null;
		this.insertButtonEl = null;
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

		const urlSetting = new Setting(containerEl)
			.setName('Immich URL')
			.setDesc('Full URL to your immich instance.');
		// Said here rather than on the next failed request, which would report it
		// as a connection problem and send the user looking at the wrong setting.
		const urlProblemEl = urlSetting.descEl.createDiv({cls: 'obsidian-immich-setting-error'});
		const showUrlProblem = (value: string) => {
			// Nothing to complain about while the field is simply still empty.
			const problem = value ? immichUrlProblem(value) : null;
			urlProblemEl.setText(problem ?? '');
			urlProblemEl.toggleClass('is-visible', problem !== null);
		};
		urlSetting.addText(text => text
			.setValue(this.plugin.settings.immichUrl)
			.onChange(async (value) => {
				this.plugin.settings.immichUrl = normalizeImmichUrl(value);
				showUrlProblem(this.plugin.settings.immichUrl);
				await this.plugin.saveSettings();
			}));
		showUrlProblem(this.plugin.settings.immichUrl);
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
					// Disabled while it runs: the test makes up to four requests,
					// and nothing else indicates that one is already in flight.
					button.setDisabled(true);
					try {
						await testConnection(this.plugin.credentials())
					} finally {
						button.setDisabled(false);
					}
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
