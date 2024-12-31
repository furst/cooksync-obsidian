import {
	App,
	ButtonComponent,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	normalizePath,
	DataAdapter,
} from "obsidian";

const baseURL = "https://go.cooksync.app";

interface AuthResponse {
	token: string;
}

interface ExportRequestResponse {
	latest_id: number;
	status: string;
}

interface CooksyncSettings {
	token: string;
	cooksyncDir: string;
	isSyncing: boolean;
	triggerOnLoad: boolean;
	lastSyncFailed: boolean;
	lastSyncTime?: number;
	recipeIDs: number[];
}

const DEFAULT_SETTINGS: CooksyncSettings = {
	token: "",
	cooksyncDir: "Cooksync",
	isSyncing: false,
	triggerOnLoad: true,
	lastSyncFailed: false,
	lastSyncTime: undefined,
	recipeIDs: [],
};

export default class Cooksync extends Plugin {
	settings: CooksyncSettings;
	fs: DataAdapter;

	async onload() {
		await this.loadSettings();

		if (
			this.settings.triggerOnLoad &&
			(!this.settings.lastSyncTime ||
				this.settings.lastSyncTime < Date.now() - 1000 * 60 * 60 * 2)
		) {
			this.startSync();
		}

		this.addCommand({
			id: "cooksync-sync",
			name: "Sync your data",
			callback: () => {
				this.startSync();
			},
		});

		//TODO: add a command to resync one recipe

		this.addSettingTab(new CooksyncSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getAuthHeaders() {
		return {
			Authorization: `Bearer ${this.settings.token}`,
			"Obsidian-Client": `${this.getObsidianClientID()}`,
		};
	}

	getErrorMessageFromResponse(response?: Response) {
		return `${response ? response.statusText : "Can't connect to server"}`;
	}

	handleSyncSuccess(
		buttonContext?: ButtonComponent
		// msg = "Synced",
		// exportID: number | null = null
	) {
		this.settings.isSyncing = false;
		this.settings.lastSyncFailed = false;

		this.saveSettings();

		if (buttonContext) {
			buttonContext.buttonEl.setText("Run sync");
		}
	}

	handleSyncError(msg: string, buttonContext?: ButtonComponent) {
		this.settings.isSyncing = false;
		this.settings.lastSyncFailed = true;
		this.saveSettings();
		if (buttonContext) {
			buttonContext.buttonEl.setText("Run sync");
		} else {
			new Notice(msg);
		}
	}

	async requestData(buttonContext?: ButtonComponent) {
		const url = `${baseURL}/api/recipes/export/obsidian`;
		let response, data: ExportRequestResponse;
		try {
			response = await fetch(url, {
				headers: {
					...this.getAuthHeaders(),
					"Content-Type": "application/json",
				},
				method: "POST",
				body: JSON.stringify({
					exportTarget: "obsidian",
					recipeIds: this.settings.recipeIDs,
				}),
			});
		} catch (e) {
			console.log("Cooksync: fetch failed in requestArchive: ", e);
		}
		if (response && response.ok) {
			data = await response.json();

			// If data, then we have new data to add
			if (data) {
				// new Notice("Syncing Cooksync data");
				// const statusBarItemEl = this.addStatusBarItem();
				// statusBarItemEl.setText("Cooksync: Syncing data");
				// Parse response and save to Obsidian
				this.downloadData(data, buttonContext);
			}

			// If no data, then we are up to date
			if (!data) {
				this.handleSyncSuccess(buttonContext);
				new Notice("Cooksync data is already up to date");
				return;
			}

			await this.saveSettings();
		} else {
			console.log(
				"Cooksync plugin: bad response in requestData: ",
				response
			);
			this.handleSyncError(
				this.getErrorMessageFromResponse(response),
				buttonContext
			);
			return;
		}
	}

	async downloadData(
		data: any,
		buttonContext?: ButtonComponent
	): Promise<void> {
		this.fs = this.app.vault.adapter;

		const checkIfFileExists = async (fileName: string) => {
			const exists = await this.fs.exists(fileName);
			return exists;
		};

		for (const entry of data) {
			const recipeTitle = entry.title.replace(/[\\/:*?"<>|]/g, "");
			const fileName = `${this.settings.cooksyncDir}/${recipeTitle}.md`;
			const processedFileName = normalizePath(fileName);
			try {
				// ensure the directory exists
				const dirPath = processedFileName.substring(
					0,
					processedFileName.lastIndexOf("/")
				);
				const exists = await this.fs.exists(dirPath);
				if (!exists) {
					await this.fs.mkdir(dirPath);
				}
				// write the actual files
				const content = entry.content;
				let originalName = processedFileName;
				const contentToSave = content;

				const extension = originalName.split(".").pop();
				const baseName = originalName.replace(`.${extension}`, "");
				let count = 1;
				while (await checkIfFileExists(originalName)) {
					originalName = `${baseName} (${count}).${extension}`;
					count++;
				}
				await this.fs.write(originalName, contentToSave);
				this.settings.recipeIDs.push(entry.id);
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();

				new Notice("Cooksync: sync completed");
			} catch (e) {
				console.log(`Cooksync: error writing ${processedFileName}:`, e);
				new Notice(`Error writing file ${processedFileName}: ${e}`);
			}
		}

		this.handleSyncSuccess(buttonContext);
	}

	startSync() {
		if (this.settings.isSyncing) {
			new Notice("Cooksync sync already in progress");
		} else {
			this.settings.isSyncing = true;
			this.saveSettings();
			this.requestData();
		}
	}

	getObsidianClientID() {
		let obsidianClientId = window.localStorage.getItem(
			"cooksync-ObsidianClientId"
		);
		if (obsidianClientId) {
			return obsidianClientId;
		} else {
			obsidianClientId = Math.random().toString(36).substring(2, 15);
			window.localStorage.setItem(
				"cooksync-ObsidianClientId",
				obsidianClientId
			);
			return obsidianClientId;
		}
	}

	async getUserAuthToken(button: HTMLElement, attempt = 0) {
		const uuid = this.getObsidianClientID();

		if (attempt === 0) {
			window.open(`${baseURL}/export?uuid=${uuid}&service=obsidian`);
		}

		let response;
		let data: AuthResponse;
		try {
			response = await fetch(`${baseURL}/api/clients/token?uuid=${uuid}`);
		} catch (e) {
			console.log(
				"Cooksync plugin: fetch failed in getUserAuthToken: ",
				e
			);
			new Notice("Authorization failed. Please try again");
		}
		if (response && response.ok) {
			data = await response.json();
		} else {
			console.log(
				"Cooksync plugin: bad response in getUserAuthToken: ",
				response
			);

			return;
		}
		if (data.token) {
			this.settings.token = data.token;
		} else {
			if (attempt > 50) {
				console.log(
					"Cooksync plugin: reached attempt limit in getUserAuthToken"
				);
				return;
			}
			console.log(
				`Cooksync plugin: didn't get token data, retrying (attempt ${
					attempt + 1
				})`
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			await this.getUserAuthToken(button, attempt + 1);
		}
		await this.saveSettings();
		return true;
	}
}

class CooksyncSettingTab extends PluginSettingTab {
	plugin: Cooksync;

	constructor(app: App, plugin: Cooksync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h1", { text: "Cooksync" });
		containerEl.createEl("p", { text: "Created by " }).createEl("a", {
			text: "Cooksync",
			href: "https://cooksync.app",
		});
		containerEl.createEl("h2", { text: "Settings" });

		if (!this.plugin.settings.token) {
			new Setting(containerEl)
				.setName("Connect Obsidian to Cooksync")
				.setDesc(
					"Enable automatic syncing between Obsidian and Cooksync. Note: Requires Cooksync account"
				)
				.addButton((button) => {
					button
						.setButtonText("Connect")
						.setCta()
						.onClick(async (evt) => {
							const success = await this.plugin.getUserAuthToken(
								evt.target as HTMLElement
							);
							if (success) {
								this.display();
							}
						});
				});
		}

		if (this.plugin.settings.token) {
			new Setting(containerEl)
				.setName("Sync your Cooksync data with Obsidian")
				.setDesc(
					"On first sync, the Cooksync plugin will create a new folder containing all your recipes"
				)
				.addButton((button) => {
					button
						.setCta()
						.setTooltip(
							"Once the sync begins, you can close this plugin page"
						)
						.setButtonText("Initiate Sync")
						.onClick(async () => {
							if (this.plugin.settings.isSyncing) {
								new Notice("Sync already in progress");
							} else {
								this.plugin.settings.isSyncing = true;
								await this.plugin.saveData(
									this.plugin.settings
								);
								button.setButtonText("Syncing...");
								await this.plugin.requestData(button);
							}
						});
				});

			new Setting(containerEl)
				.setName("Customize import options")
				.setDesc("Customize recipe import, such as tags")
				.addButton((button) => {
					button.setButtonText("Customize").onClick(() => {
						window.open(`${baseURL}/export/obsidian`);
					});
				});

			new Setting(containerEl)
				.setName("Customize base folder")
				.setDesc(
					"By default, the plugin will save all your recipes into a folder named Cooksync"
				)
				.addText((text) =>
					text
						.setPlaceholder("Defaults to: Cooksync")
						.setValue(this.plugin.settings.cooksyncDir)
						.onChange(async (value) => {
							this.plugin.settings.cooksyncDir = normalizePath(
								value || "Cooksync"
							);
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Sync automatically when Obsidian opens")
				.setDesc(
					"If enabled, Obsidian will automatically resync with Cooksync each time the app is opened"
				)
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.triggerOnLoad);
					toggle.onChange((val) => {
						this.plugin.settings.triggerOnLoad = val;
						this.plugin.saveSettings();
					});
				});
		}

		const help = containerEl.createEl("p", {
			text: "Issues? Please email us at ",
		});
		help.createEl("a", {
			text: "info@cooksync.app",
			href: "mailto:info@cooksync.app",
		});
	}
}
