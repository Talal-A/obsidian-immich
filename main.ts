import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

// Remember to rename these classes and interfaces!

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

export default class ObsidianImmich extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon. Currently used just for testing.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Immich', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});

		this.addCommand({
			id: 'insert-from-immich',
			name: 'Insert from Immich',
			editorCallback: (editor: Editor) => {
				new ImageSelectorModal(this.app, editor, this.settings).open();
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

	constructor(app: App, editor: Editor, settings: PluginSettings) {
		super(app);
		this.editor = editor;
		this.settings = settings;
	}

	async onOpen() {
		const {contentEl} = this;

		const url = new URL(this.settings.immichUrl + '/api/albums/' + this.settings.immichAlbum);
		const result = await requestUrl({
			url: url.toString(),
			headers: {
				'Accept': 'application/json',
				'x-api-key': this.settings.immichApiKey.toString()
			}
		})

		for (let i = 0; i < result.json['assets'].length; i++) {
			const thumbUrl = this.settings.immichUrl + '/api/assets/' + result.json['assets'][i]['id'] + '/thumbnail?size=thumbnail&key=' + this.settings.immichAlbumKey;
			const previewUrl = this.settings.immichUrl + '/api/assets/' + result.json['assets'][i]['id'] + '/thumbnail?size=preview&key=' + this.settings.immichAlbumKey;
			const insertionText = '![](' + previewUrl + ')\n';
			const imgElement = contentEl.createEl("img");
			imgElement.src = thumbUrl;
			imgElement.width = 250;
			imgElement.onclick = () => this.editor.replaceRange(insertionText, this.editor.getCursor());
		}
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
