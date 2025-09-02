import { App, TFile } from "obsidian";

export function wireAutoscan(app: App, onChange: () => void) {
	const vault = app.vault;
	const handler = async (af: any) => {
		if (!(af instanceof TFile)) return;
		if (af.extension !== "md") return;
		onChange();
	};
	vault.on("modify", handler);
	vault.on("create", handler);
	vault.on("rename", handler);
	vault.on("delete", handler);
	app.workspace.on("file-open", onChange);
}
