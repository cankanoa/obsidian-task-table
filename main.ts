import {
	App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf
} from "obsidian";
import { TaskTableView } from "./views/TaskTableView";

export const TASK_TABLE_VIEW_TYPE = "task-table-view";

export interface TaskTableRule { name: string; re: string; }
export interface MyPluginSettings {
	regexRules: TaskTableRule[];
}
const DEFAULT_SETTINGS: MyPluginSettings = {
	regexRules: [{ name: "Planner", re: ".*/Planner/.*\\.md$" }],
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(TASK_TABLE_VIEW_TYPE, (leaf) =>
			new TaskTableView(leaf, {
				settings: this.settings,
				openSettings: () => this.openSettings(),
			})
		);

		this.addRibbonIcon("dice", "Open Task Table", async () => {
			await this.activateView();
		});

		this.addSettingTab(new RulesSettingTab(this.app, this));
	}

	async activateView() {
		const leaves = this.app.workspace.getLeavesOfType(TASK_TABLE_VIEW_TYPE);
		if (leaves.length) return this.app.workspace.revealLeaf(leaves[0]);
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: TASK_TABLE_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	openSettings() {
		// Robustly open Settings and focus this plugin's tab
		const setting = (this.app as any).setting;
		if (!setting) return;
		setting.open(); // ensure panel is open
		const id = this.manifest.id; // PluginSettingTab id defaults to manifest.id
		if (typeof setting.openTabById === "function") {
			setting.openTabById(id);
		} else if (setting.activeTab?.id !== id) {
			// fallback: iterate tabs if API is older
			const tabs = setting.tabs ?? setting.tabGroup?.tabs ?? [];
			const mine = tabs.find((t: any) => t.id === id);
			if (mine) setting.openTab(mine);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async notifySettingsChanged() {
		await this.saveSettings(); // persist
		// refresh all open TaskTable views
		for (const leaf of this.app.workspace.getLeavesOfType(TASK_TABLE_VIEW_TYPE)) {
			const v = leaf.view as any;
			if (typeof v.refresh === "function") {
				await v.refresh();
			}
		}
	}
}

class RulesSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Minimal inline styles (scoped via a unique class)
		containerEl.addClass("tt-rules");
		let style = containerEl.querySelector("style[data-tt]") as HTMLStyleElement | null;
		if (!style) {
			style = document.createElement("style");
			style.dataset.tt = "1";
			style.textContent = `
      .tt-rules .tt-grid { display: grid; grid-template-columns: 1fr 2fr auto; gap: 8px; align-items: center; }
      .tt-rules .tt-head { font-weight: 600; opacity: .9; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 4px; margin-bottom: 8px; }
      .tt-rules .tt-row  { margin: 6px 0; }
      .tt-rules input[type="text"] { width: 100%; }
      .tt-rules .tt-icon-btn { background: transparent; border: none; cursor: pointer; padding: 6px; }
      .tt-rules .tt-add { font-weight: 700; }
      .tt-rules .tt-trash { color: var(--text-muted); }
      .tt-rules .tt-trash:hover { color: var(--text-normal); }
      `;
			containerEl.appendChild(style);
		}

		// Header row: Group | Regex | [+]
		const head = containerEl.createDiv({ cls: "tt-grid tt-head" });
		head.createSpan({ text: "Group" });
		head.createSpan({ text: "Regex" });
		const addWrap = head.createDiv();
		const addBtn = addWrap.createEl("button", { cls: "tt-icon-btn tt-add", attr: { "aria-label": "Add rule", title: "Add rule" } });
		addBtn.textContent = "+";

		const listEl = containerEl.createDiv();

		const render = () => {
			listEl.empty();
			this.plugin.settings.regexRules.forEach((rule, idx) => {
				const row = listEl.createDiv({ cls: "tt-grid tt-row" });

				// Group (name)
				const nameInput = row.createEl("input", { type: "text" });
				nameInput.placeholder = "e.g., Planner";
				nameInput.value = rule.name ?? "";
				nameInput.oninput = async () => {
					rule.name = nameInput.value;
					await this.plugin.saveSettings();
				};

				// Regex
				const reInput = row.createEl("input", { type: "text" });
				reInput.placeholder = ".*/Planner/.*\\.md$";
				reInput.value = rule.re ?? "";
				reInput.oninput = async () => {
					rule.re = reInput.value;
					await this.plugin.saveSettings();
				};

				// Trash
				const trashWrap = row.createDiv();
				const delBtn = trashWrap.createEl("button", {
					cls: "tt-icon-btn tt-trash",
					attr: { "aria-label": "Delete rule", title: "Delete rule" },
				});
				delBtn.textContent = "🗑";
				delBtn.onclick = async () => {
					this.plugin.settings.regexRules.splice(idx, 1);
					await this.plugin.saveSettings();
					render();
				};
			});
		};

		addBtn.onclick = async () => {
			this.plugin.settings.regexRules.push({ name: "", re: "" });
			await this.plugin.saveSettings();
			render();
		};

		render();
	}

	hide(): void {
		// when the user leaves the tab, re-render the view(s)
		this.plugin.notifySettingsChanged();
	}
}
