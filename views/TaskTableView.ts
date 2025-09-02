import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { TASK_TABLE_VIEW_TYPE, MyPluginSettings } from "../main";
import { createStyles } from "../ui/styles";
import { createScaffold } from "../ui/scaffold";
import { mountTable } from "../ui/render";
import { wireAutoscan } from "../ui/autoscan";
import { Store } from "../state/store";

export class TaskTableView extends ItemView {
	private plugin: { settings: MyPluginSettings; openSettings: () => void };
	private store: Store | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: { settings: MyPluginSettings; openSettings: () => void }) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return TASK_TABLE_VIEW_TYPE; }
	getDisplayText() { return "Task Table"; }

	async onOpen() {
		const container = (this.containerEl.querySelector(".view-content") as HTMLElement) ?? this.containerEl;
		container.empty();

		createStyles(this);
		const ui = createScaffold(container, { onOpenSettings: this.plugin.openSettings });

		this.store = new Store(this.app, this.plugin.settings, ui);
		await mountTable(this.store);

		wireAutoscan(this.app, async () => {
			if (!this.store) return;
			await mountTable(this.store);
		});
	}

	async onClose() {
		// noop — Store cleans itself when re-mounted
	}

	async refresh() {
		if (!this.store) return;
		this.store.settings = this.plugin.settings;
		await mountTable(this.store);
	}
}
