import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, RequestUrlResponse, Setting, requestUrl } from 'obsidian';

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

let cachedResult: RequestUrlResponse;

async function refreshCacheFromImmich(settings: PluginSettings) {
	const url = new URL(settings.immichUrl + '/api/albums/' + settings.immichAlbum);
	const result = await requestUrl({
		url: url.toString(),
		headers: {
			'Accept': 'application/json',
			'x-api-key': settings.immichApiKey.toString()
		}
	})	
	cachedResult = result;
}

export default class ObsidianImmich extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'insert-from-immich',
			name: 'Insert from Immich',
			editorCallback: (editor: Editor) => {
				new ImageSelectorModal(this.app, editor, this.settings).open();
			}
		});
 
		this.addCommand({
			id: 'force-refresh-immich-cache',
			name: 'Refresh immich cache',
			callback: () => {
				refreshCacheFromImmich(this.settings);
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ImageSelectorModal extends Modal {
	editor: Editor;
	settings: PluginSettings;
	page: number;

	constructor(app: App, editor: Editor, settings: PluginSettings) {
		super(app);
		this.editor = editor;
		this.settings = settings;
		this.page = 0;
	}

	async onOpen() {
		const {contentEl} = this;

		if (cachedResult == null) {
			await refreshCacheFromImmich(this.settings);
		}

		// Get the width of the viewport
		const totalWidth = contentEl.innerWidth;

		const imageDiv = contentEl.createDiv();
		const bottomDiv = contentEl.createDiv();
		let observer = new IntersectionObserver(() => {
			const startIndex = this.page;
			let endIndex = this.page + 16;
			if (endIndex > cachedResult.json['assets'].length) {
				endIndex = cachedResult.json['assets'].length;
			}
			this.page = endIndex;
			for (let i = startIndex; i < endIndex; i++) {
				const thumbUrl = this.settings.immichUrl + '/api/assets/' + cachedResult.json['assets'][i]['id'] + '/thumbnail?size=thumbnail&key=' + this.settings.immichAlbumKey;
				const previewUrl = this.settings.immichUrl + '/api/assets/' + cachedResult.json['assets'][i]['id'] + '/thumbnail?size=preview&key=' + this.settings.immichAlbumKey;
				const insertionText = '![](' + previewUrl + ')\n';
				const imgElement = imageDiv.createEl("img");
				imgElement.src = thumbUrl;
				imgElement.width = (totalWidth / 2) - 1;
				imgElement.onclick = () => this.editor.replaceSelection(insertionText);
			}
			
		}, {threshold: [0.1]});
		observer.observe(bottomDiv);
	}

	onClose() {
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
					this.plugin.settings.immichUrl = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich API Key')
			.setDesc('Obtained from {IMMICH_URL}/user-settings?isOpen=api-keys.')
			.addText(text => text
				.setValue(this.plugin.settings.immichApiKey)
				.onChange(async (value) => {
					this.plugin.settings.immichApiKey = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich Album ID')
			.setDesc('UUID for the `obsidian` album in immich.')
			.addText(text => text
				.setValue(this.plugin.settings.immichAlbum)
				.onChange(async (value) => {
					this.plugin.settings.immichAlbum = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Immich Album Share Key')
			.setDesc('Share key which shows up in the URL of your album.')
			.addText(text => text
				.setValue(this.plugin.settings.immichAlbumKey)
				.onChange(async (value) => {
					this.plugin.settings.immichAlbumKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
