import { App, TFile } from "obsidian";
import type { Store } from "../state/store";
import { debounce } from "../utils/debounce";
import { invalidateCachedFile } from "../data/scan";


export function wireAutoscan(app: App, store: Store, onTrigger: () => void|Promise<void>) {
	const vault = app.vault;
	const run = debounce(async () => { if (!store) return; await onTrigger(); }, 300);
	const handler = async (af: any) => {
		if (store.squelchScanDepth > 0) return;
		if (!(af instanceof TFile) || af.extension !== "md") return;
		const isIndexed = store.providers.getIndexedFiles().some(f => f.path === af.path);
		if (!isIndexed) return;
		invalidateCachedFile(af.path);

		run();
	};
	vault.on("modify", handler);
	vault.on("create", handler);
	vault.on("rename", handler);
	vault.on("delete", handler);
	return () => { vault.off("modify", handler); vault.off("create", handler); vault.off("rename", handler); vault.off("delete", handler); };
}
