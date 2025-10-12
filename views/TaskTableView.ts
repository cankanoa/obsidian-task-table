import { ItemView, WorkspaceLeaf } from "obsidian";
import { TASK_TABLE_VIEW_TYPE, MyPluginSettings } from "../main";
import { createStyles } from "../ui/styles";
import { createScaffold } from "../ui/scaffold";
import { mountTable } from "../ui/render";
import { wireAutoscan } from "../ui/autoscan";
import { Store } from "../state/store";
import type { TFile } from "obsidian";

type PluginAPI = {
	settings: MyPluginSettings;
	openSettings: () => void;
	getIndexedFiles: () => TFile[];
	rescanIndex: () => Promise<number>;
};

export class TaskTableView extends ItemView {
	private plugin: PluginAPI;
	private store: Store | null = null;
	private disposeAutoscan: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PluginAPI) {
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

		// Pass providers object into Store
		this.store = new Store(this.app, this.plugin.settings, ui, {
			getIndexedFiles: this.plugin.getIndexedFiles,
		});

		// Discover new files only now (view open)
		await this.plugin.rescanIndex();

		// Mount using cached index via store.providers
		await mountTable(this.store);

		// Autoscan: just refresh the table using cached files
		this.disposeAutoscan = wireAutoscan(this.app, this.store, async () => {
			if (!this.store) return;
			await mountTable(this.store);
		});
	}

	async refresh() {
		if (!this.store) return;
		this.store.settings = this.plugin.settings;
		await mountTable(this.store);
	}

	async onClose() {
		// remove autoscan listeners
		try { this.disposeAutoscan?.(); } catch {}
		this.disposeAutoscan = null;

		// clear any per-row pending timers & unload components
		if (this.store?.rowRefs?.length) {
			for (const r of this.store.rowRefs) {
				if (r.renderTimer) { window.clearTimeout(r.renderTimer); r.renderTimer = undefined; }
				r.mdComp?.unload?.();
			}
		}

		// remove injected <style>
		(this as any)._tt_dispose?.();

		// cancel autosave timer (see save.ts patch)
		try { (await import("../io/save")).clearAutosave?.(this.store as any); } catch {}
		this.store = null;
	}
}
