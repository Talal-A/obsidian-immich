import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

// Remember to rename these classes and interfaces!

interface PluginSettings {
	immichUrl: string;
	immichApiKey: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	immichUrl: '',
	immichApiKey: ''
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

	onOpen() {
		const {contentEl} = this;
		contentEl.setText("Working with " +  this.settings.immichUrl);
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
	}
}
