import { App, TFile } from "obsidian";
import type { Store } from "../state/store";

export function wireAutoscan(
	app: App,
	store: Store,
	onTrigger: () => void | Promise<void>
) {
	const vault = app.vault;
	const handler = async (af: any) => {
		// ⬇️ skip rescans while we are doing our own writes
		if (store.squelchScanDepth > 0) return;

		if (!(af instanceof TFile)) return;
		if (af.extension !== "md") return;

		await onTrigger();
	};
	vault.on("modify", handler);
	vault.on("create", handler);
	vault.on("rename", handler);
	vault.on("delete", handler);
	return () => {
		vault.off("modify", handler);
		vault.off("create", handler);
		vault.off("rename", handler);
		vault.off("delete", handler);
	};
}
