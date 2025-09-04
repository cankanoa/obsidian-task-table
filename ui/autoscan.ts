import { App, TFile } from "obsidian";

export function wireAutoscan(app: App, onChange: () => void): () => void {
	// simple debounce to coalesce bursts of events
	let t: number | undefined;
	const ping = () => {
		if (t) window.clearTimeout(t);
		t = window.setTimeout(onChange, 250);
	};

	const vault = app.vault;
	const handler = async (af: any) => {
		if (!(af instanceof TFile)) return;
		if (af.extension !== "md") return;
		ping();
	};

	vault.on("modify", handler);
	vault.on("create", handler);
	vault.on("rename", handler);
	vault.on("delete", handler);
	app.workspace.on("file-open", ping);

	// ← IMPORTANT: return disposer
	return () => {
		if (t) window.clearTimeout(t);
		vault.off("modify", handler);
		vault.off("create", handler);
		vault.off("rename", handler);
		vault.off("delete", handler);
		app.workspace.off("file-open", ping);
	};
}
