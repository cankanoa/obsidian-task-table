import { ItemView, WorkspaceLeaf } from "obsidian";
import { TASK_TABLE_VIEW_TYPE, MyPluginSettings } from "../main";
import { createStyles } from "../ui/styles";
import { createScaffold } from "../ui/scaffold";
import { mountTable } from "../ui/render";
import { wireAutoscan } from "../ui/autoscan";
import { Store } from "../state/store";

export class TaskTableView extends ItemView {
	private plugin: { settings: MyPluginSettings; openSettings: () => void };
	private store: Store | null = null;
	private disposeAutoscan: (() => void) | null = null;

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

		this.disposeAutoscan = wireAutoscan(
			this.app,
			this.store,   // ← pass the store
			async () => {
				if (!this.store) return;
				await mountTable(this.store);
			}
		);
	}

	// Allow plugin to re-render after settings close
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
