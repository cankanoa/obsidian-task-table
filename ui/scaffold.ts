import { UIRefs } from "../types";

export function createScaffold(container: HTMLElement, opts: { onOpenSettings: () => void }): UIRefs {
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.height = "100%";
	container.style.padding = "0";

	const statusBar = container.createDiv();
	statusBar.style.flex = "0 0 auto";
	statusBar.style.display = "flex";
	statusBar.style.alignItems = "center";
	statusBar.style.justifyContent = "space-between";
	statusBar.style.height = "28px";
	statusBar.style.padding = "0 12px 0 8px";
	statusBar.style.borderBottom = "1px solid var(--background-modifier-border)";

	const leftWrap = statusBar.createDiv();
	leftWrap.style.display = "inline-flex";
	leftWrap.style.alignItems = "center";
	leftWrap.style.gap = "8px";

	const gearBtn = leftWrap.createEl("button");
	gearBtn.setAttr("aria-label", "Open settings");
	Object.assign(gearBtn.style, { background: "transparent", border: "none", padding: "0 4px", cursor: "pointer", fontSize: "16px" });
	gearBtn.textContent = "⚙︎";
	gearBtn.onclick = () => opts.onOpenSettings();

	const rightWrap = statusBar.createDiv();
	rightWrap.style.display = "inline-flex";
	rightWrap.style.alignItems = "center";
	const statusIcon = rightWrap.createSpan();
	statusIcon.setAttr("aria-label", "save status");
	Object.assign(statusIcon.style, {
		display: "inline-flex", alignItems: "center", justifyContent: "center",
		width: "18px", height: "18px", fontSize: "14px", opacity: "0.9", marginRight: "6px",
	});

	const scroller = container.createDiv();
	scroller.style.flex = "1 1 auto";
	scroller.style.overflow = "auto";

	const table = scroller.createEl("table");
	table.style.width = "100%";
	table.style.borderCollapse = "collapse";
	table.style.fontFamily = "var(--font-interface)";
	const tbody = table.createEl("tbody");

	return { container, statusBar, statusIcon, scroller, table, tbody };
}
