import {MarkdownRenderer, Notice, Component, setIcon} from "obsidian";
import { Store } from "../state/store";
import { compileRules, scanTasks } from "../data/scan";
import { GroupBucket, RowRef, TaskEntry } from "../types";
import { buildLine, hsl } from "../utils/text";
import * as Move from "../io/move";
import * as Save from "../io/save";

export async function mountTable(store: Store) {
	const scroller = store.ui?.scroller;
	const prevScroll = scroller?.scrollTop ?? 0;

	const compiled = compileRules(store.settings.regexRules ?? []);
	const files = store.providers.getIndexedFiles();

	const result = await scanTasks(store.app, compiled, files);
	store.applyScan(result);

	// Clear table
	for (const r of store.rowRefs) r.mdComp?.unload?.();
	store.resetTableMaps();
	store.ui.tbody.empty();
	updateStatusIcon(store);

	// Rebuild table content
	if (result.groups.length > 0) {
		if (!result.hasGroups) {
			const only = result.groups[0]; // "__ALL__"
			for (const fb of only.files) {
				const fileKey = `__ALL__::${fb.filePath}`;
				addFileHeader(store, fb.filePath, fb.fileName, "__ALL__", false, fileKey);
				for (const e of fb.items) {
					addTaskRow(store, e, !!store.childrenById.get(e.id)?.length, "__ALL__", fileKey);
				}
				addNewPlaceholder(store, fb.filePath, "__ALL__", fileKey);
			}
		} else {
			for (const group of result.groups) {
				addGroupHeader(store, group);
				for (const fb of group.files) {
					const fileKey = `${group.key}::${fb.filePath}`;
					addFileHeader(store, fb.filePath, fb.fileName, group.key, true, fileKey);
					for (const e of fb.items) {
						addTaskRow(store, e, !!store.childrenById.get(e.id)?.length, group.key, fileKey);
					}
					addNewPlaceholder(store, fb.filePath, group.key, fileKey);
				}
			}
		}
	}

	// Padding row
	const padTr = store.ui.tbody.createEl("tr");
	const padTd = padTr.createEl("td");
	padTd.colSpan = 2;
	padTd.style.padding = "12px 8px";

	// Style pass
	store.silentStylePass = true;
	for (const r of store.rowRefs) {
		const rk = `${r.groupKey}::${r.filePath}`;
		const hidden = hasCollapsedAncestor(store, r.id)
			|| store.collapsedGroups.has(r.groupKey)
			|| store.collapsedFiles.has(rk);
		r.tr.style.display = hidden ? "none" : "";
		styleAndWireNumber(store, r);
	}
	store.silentStylePass = false;

	// Focus (clear pending before use to avoid loop)
	const id = store.pendingFocusId;
	store.pendingFocusId = null;
	if (id) {
		const ref = store.rowById.get(id);
		if (ref) {
			ref.previewCell.hide();
			ref.textCell.show();
			const sel = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(ref.textCell);
			range.collapse(false);
			sel?.removeAllRanges();
			sel?.addRange(range);
			ref.textCell.focus();
		}
	}

	// Restore scroll position
	queueMicrotask(() => {
		if (scroller) scroller.scrollTop = prevScroll;
	});
}


export function updateStatusIcon(store: Store) {
	const el = store.ui.statusIcon;
	el.style.display = "inline-block";
	el.style.lineHeight = "1";
	el.style.margin = "0";
	el.style.padding = "0";
	if (store.savingDepth > 0 || store.dirty) {
		el.style.fontSize = "22px";
		el.textContent = "⟳";
		el.title = store.savingDepth > 0 ? "Saving…" : "Unsaved edits…";
	} else {
		el.style.fontSize = "18px";
		el.textContent = "✓";
		el.title = "Saved";
	}
}

function makeChevronButton(expanded: boolean) {
	const btn = document.createElement("button");
	Object.assign(btn.style, { background: "transparent", border: "none", padding: "0 6px 0 2px", cursor: "pointer", lineHeight: "1" });
	btn.tabIndex = -1; btn.onmousedown = e => e.preventDefault();
	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "14"); svg.setAttribute("height", "14");
	svg.style.verticalAlign = "-1px";
	const path = document.createElementNS(svgNS, "path");
	path.setAttribute("d", "M4 6 L8 10 L12 6");
	path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
	svg.appendChild(path);
	if (!expanded) svg.style.transform = "rotate(-90deg)";
	btn.appendChild(svg);
	(btn as any)._setExpanded = (isOpen: boolean) => { svg.style.transform = isOpen ? "rotate(0deg)" : "rotate(-90deg)"; };
	return btn;
}

function addGroupHeader(store: Store, bucket: GroupBucket) {
	// Group header row (visible only in grouped mode)
	const tr = store.ui.tbody.createEl("tr");
	const td = tr.createEl("td");
	td.colSpan = 2;
	td.classList.add("task-cell");
	Object.assign(td.style, {
		padding: "8px 8px",
		fontWeight: "700",
		fontSize: "1.05rem",
		background: "transparent",
		borderBottom: "1px solid var(--background-modifier-border)",
	});
	const wrap = td.createDiv();
	wrap.style.display = "flex";
	wrap.style.alignItems = "center";

	const expanded = !store.collapsedGroups.has(bucket.key);
	const chev = makeChevronButton(expanded);
	wrap.appendChild(chev);

	const label = wrap.createSpan({ text: bucket.name });
	label.style.userSelect = "none";
	label.style.cursor = "pointer";

	const toggle = () => {
		const collapsing = !store.collapsedGroups.has(bucket.key);
		if (collapsing) store.collapsedGroups.add(bucket.key);
		else store.collapsedGroups.delete(bucket.key);
		(chev as any)._setExpanded(!collapsing);

		for (const fb of bucket.files) {
			const fileKey = `${bucket.key}::${fb.filePath}`;
			const ftr = store.fileHeaderRow.get(fileKey);
			if (ftr) ftr.style.display = collapsing ? "none" : "";

			const newTr = store.newRowByFile.get(fileKey);
			if (newTr) newTr.style.display = collapsing || store.collapsedFiles.has(fileKey) ? "none" : "";

			for (const r of store.rowRefs) {
				if (r.groupKey !== bucket.key) continue;
				if (r.filePath !== fb.filePath) continue;
				const rk = `${r.groupKey}::${r.filePath}`;
				r.tr.style.display =
					collapsing || store.collapsedFiles.has(rk) || hasCollapsedAncestor(store, r.id)
						? "none"
						: "";
			}
		}
	};
	chev.onclick = toggle;
	label.onclick = toggle;

	store.groupHeaderRow.set(bucket.key, tr);
}

function addFileHeader(
	store: Store,
	filePath: string,
	fileName: string,
	groupKey: string,
	showGroupHeader: boolean,
	fileKey: string
) {
	// In single-layer mode, we still reuse this helper—just pass showGroupHeader=false
	const tr = store.ui.tbody.createEl("tr");
	const td = tr.createEl("td");
	td.colSpan = 2;
	td.classList.add("task-cell");
	Object.assign(td.style, {
		padding: "6px 8px",
		fontWeight: "500",
		fontSize: "1rem",
		background: "transparent",
		borderBottom: "1px solid var(--background-modifier-border)",
	});

	const wrap = td.createDiv();
	wrap.style.display = "flex";
	wrap.style.alignItems = "center";

	const expanded = !store.collapsedFiles.has(fileKey) && (!showGroupHeader || !store.collapsedGroups.has(groupKey));
	const chev = makeChevronButton(expanded);
	wrap.appendChild(chev);

	const cleanName = fileName.replace(/\.md$/i, "");
	const label = wrap.createSpan({ text: cleanName });
	label.style.userSelect = "none";
	label.style.cursor = "pointer";

	const toggle = () => {
		const collapsing = !store.collapsedFiles.has(fileKey);
		if (collapsing) store.collapsedFiles.add(fileKey);
		else store.collapsedFiles.delete(fileKey);
		(chev as any)._setExpanded(!collapsing);

		for (const r of store.rowRefs) {
			if (r.filePath !== filePath) continue;
			if (showGroupHeader && store.collapsedGroups.has(groupKey)) { r.tr.style.display = "none"; continue; }
			r.tr.style.display = collapsing || hasCollapsedAncestor(store, r.id) ? "none" : "";
		}

		const newTr = store.newRowByFile.get(fileKey);
		if (newTr) {
			newTr.style.display = (showGroupHeader && store.collapsedGroups.has(groupKey)) || collapsing ? "none" : "";
		}
	};

	chev.onclick = toggle;
	label.onclick = toggle;

	if (showGroupHeader && store.collapsedGroups.has(groupKey)) tr.style.display = "none";
	store.fileHeaderRow.set(fileKey, tr);
}

function styleAndWireNumber(store: Store, row: RowRef) {
	const { numEl, hasChildren, id, depth, rootToken } = row;
	Object.assign(numEl.style, {
		display: "inline-flex", alignItems: "center", justifyContent: "center",
		width: "1.5em", height: "1.5em", minWidth: "1.5em", flex: "0 0 auto",
		borderRadius: "4px", fontVariantNumeric: "tabular-nums", transformOrigin: "50% 50%",
		cursor: "grab", transition: store.silentStylePass ? "none" : "transform 120ms ease-out"
	} as CSSStyleDeclaration);
	numEl.style.fontWeight = hasChildren ? "900" as any : "100" as any;

	const hue = store.hueByRootToken.get(rootToken) ?? 0;
	const light = Math.min(store.L_MAX, store.L_BASE + (depth - 1) * store.L_STEP);
	numEl.style.color = hsl(hue, store.SAT, light);

	if (hasChildren) {
		numEl.title = "Show/hide sub-tasks";
		numEl.style.transform = store.collapsed.has(id) ? "rotate(-90deg)" : "rotate(0deg)";
	} else {
		numEl.removeAttribute("title");
		numEl.style.transform = "none";
	}

	numEl.setAttribute("draggable", "true");
	numEl.ondragstart = (e) => {
		store.draggingId = row.id;
		numEl.style.cursor = "grabbing";
		e.dataTransfer?.setData("text/plain", row.id);
		const ghost = document.createElement("div");
		ghost.textContent = "Moving…";
		Object.assign(ghost.style, { padding: "2px 6px", background: "var(--background-secondary)", border: "1px solid var(--background-modifier-border)" });
		document.body.appendChild(ghost);
		e.dataTransfer?.setDragImage(ghost, 10, 10);
		setTimeout(() => ghost.remove(), 0);
	};
	numEl.ondragend = () => {
		numEl.style.cursor = "grab"; store.draggingId = null; clearHoverStyles(store);
	};
	numEl.onclick = (e) => {
		if ((e as any).detail === 0) return;
		if (hasChildren) { e.preventDefault(); e.stopPropagation(); toggleNode(store, id); }
	};

	row.tr.addEventListener("dragover", (e) => onRowDragOver(store, e, row));
	row.tr.addEventListener("dragleave", () => onRowDragLeave(store, row));
	row.tr.addEventListener("drop", (e) => onRowDrop(store, e, row));
}

function toggleNode(store: Store, id: string) {
	if (store.collapsed.has(id)) expand(store, id);
	else collapse(store, id);
}
function collapse(store: Store, id: string) {
	store.collapsed.add(id);
	const row = store.rowById.get(id);
	if (row) styleAndWireNumber(store, row);
	for (const childId of getDescendants(store, id)) {
		const childRow = store.rowById.get(childId);
		if (childRow) childRow.tr.style.display = "none";
	}
}
function expand(store: Store, id: string) {
	store.collapsed.delete(id);
	const row = store.rowById.get(id);
	if (row) styleAndWireNumber(store, row);
	for (const childId of getDescendants(store, id)) {
		const r = store.rowById.get(childId);
		if (!r) continue;
		if (hasCollapsedAncestor(store, childId)) continue;
		if (store.collapsedGroups.has(r.groupKey) || store.collapsedFiles.has(r.filePath)) continue;
		r.tr.style.display = "";
	}
}
function hasCollapsedAncestor(store: Store, id: string): boolean {
	let current = store.rowById.get(id);
	while (current?.parentId) {
		if (store.collapsed.has(current.parentId)) return true;
		current = store.rowById.get(current.parentId);
	}
	return false;
}
function getDescendants(store: Store, id: string): string[] {
	const out: string[] = [];
	const stack = [...(store.childrenById.get(id) || [])];
	while (stack.length) {
		const cur = stack.pop()!;
		out.push(cur);
		const kids = store.childrenById.get(cur);
		if (kids && kids.length) stack.push(...kids);
	}
	return out;
}

function onRowDragOver(store: Store, e: DragEvent, target: RowRef) {
	if (!store.draggingId || store.draggingId === target.id) return;
	e.preventDefault();
	const rect = target.tr.getBoundingClientRect();
	const y = e.clientY - rect.top;
	const t = rect.height / 3;
	let mode: "before" | "after" | "on";
	if (y < t) mode = "before";
	else if (y > rect.height - t) mode = "after";
	else mode = "on";
	if (!store.hoverTarget || store.hoverTarget.id !== target.id || store.hoverTarget.mode !== mode) {
		clearHoverStyles(store);
		store.hoverTarget = { id: target.id, mode };
		if (mode === "on") {
			target.tr.style.outline = "2px solid var(--text-accent)";
			(target.tr.style as any).outlineOffset = "-2px";
		} else if (mode === "before") target.tr.classList.add("hover-top");
		else target.tr.classList.add("hover-bottom");
	}
}
function onRowDragLeave(store: Store, _target: RowRef) { /* no-op */ }
function clearHoverStyles(store: Store) {
	if (!store.hoverTarget) return;
	const targetRow = store.rowById.get(store.hoverTarget.id);
	if (!targetRow) { store.hoverTarget = null; return; }
	targetRow.tr.classList.remove("hover-top", "hover-bottom");
	targetRow.tr.style.outline = "";
	(targetRow.tr.style as any).outlineOffset = "";
	store.hoverTarget = null;
}
async function onRowDrop(store: Store, e: DragEvent, target: RowRef) {
	e.preventDefault();
	const sourceId = store.draggingId || e.dataTransfer?.getData("text/plain");
	const hover = store.hoverTarget;
	store.draggingId = null;
	clearHoverStyles(store);
	if (!sourceId || !hover) return;
	if (sourceId === target.id) return;

	const source = store.rowById.get(sourceId);
	if (!source) return;

	try {
		const st = store.ui.scroller?.scrollTop ?? 0;
		await store.withSquelch(async () => {
			if (hover.mode === "on") await Move.moveAsTopChild(store, source, target);
			else {
				const after = hover.mode === "after";
				await Move.moveBetweenWithMaxNeighborDepth(store, source, target, after);
			}
		});
		await mountTable(store);
		if (store.ui.scroller) store.ui.scroller.scrollTop = st;
		new Notice("Item moved.");
	} catch (err) {
		console.error(err);
		new Notice("Move failed.");
	}
}

export function addTaskRow(store: Store, entry: TaskEntry, hasChildren: boolean, groupKey: string, fileKey: string) {
	const { file, lineIndex, originalLine, depth, rootToken, id, parentId } = entry;
	const m = originalLine.match(/^\s*([-*])\s\[( |x|X)\]\s(.+)$/);
	if (!m) return;

	const checked = m[2].toLowerCase() === "x";
	const text = m[3];

	const tr = store.ui.tbody.createEl("tr");
	tr.classList.add("task-row");

	const tdLeft = tr.createEl("td");
	tdLeft.classList.add("task-cell");
	Object.assign(tdLeft.style, { padding: "6px 8px", verticalAlign: "top", width: "100%" });
	const leftWrap = tdLeft.createDiv(); leftWrap.addClass("row-wrap");

	const numEl = leftWrap.createSpan({ text: String(depth) }); numEl.classList.add("num");

	const ctrls = leftWrap.createDiv({ cls: "tt-ctrls" });
	ctrls.style.cssText = "display:inline-flex;align-items:center;gap:6px;";

	const cb = ctrls.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
	cb.checked = checked;
	cb.style.flex = "0 0 auto";

// delete button lives next to the checkbox
	const delBtn = ctrls.createEl("button", {
		attr: { title: "Delete task & subtasks", "aria-label": "Delete task" },
	});
	setIcon(delBtn, "trash-2");
	Object.assign(delBtn.style, {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		padding: "0 6px",
		height: "1.5em",
		lineHeight: "1",
		border: "none",
		background: "transparent",
		cursor: "pointer",
	});
	const textWrap = leftWrap.createDiv();
	Object.assign(textWrap.style, { flex: "1 1 auto", minWidth: "0", position: "relative", wordBreak: "break-word" });

	const editable = textWrap.createDiv();
	editable.addClass("task-edit");
	Object.assign(editable.style, { display: "none", whiteSpace: "pre-wrap", outline: "none", minWidth: "0" });
	editable.contentEditable = "true"; editable.spellcheck = false; editable.textContent = text;

	const preview = textWrap.createDiv();
	preview.addClass("markdown-preview-view", "tt-md", "task-preview");
	Object.assign(preview.style, { minWidth: "0", cursor: "text", padding: "0" });

	const tdRight = tr.createEl("td");
	tdRight.classList.add("task-cell");
	Object.assign(tdRight.style, { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" });

	const openBtn = tdRight.createEl("button", { title: "Open" });
	openBtn.textContent = "↗"; openBtn.style.fontSize = "14px"; openBtn.style.lineHeight = "1"; openBtn.style.padding = "4px 8px";
	openBtn.onclick = async () => {
		const leaf = store.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		const anyApp = store.app as any;
		const mdView = anyApp.workspace?.getActiveFileView?.();
		const editor = mdView?.editor ?? null;
		if (editor?.setCursor) editor.setCursor({ line: lineIndex, ch: 0 });
	};

	const mdComp = new Component();
	(store as any).addChild?.(mdComp);

	const rowRef: RowRef = {
		id, parentId, depth, hasChildren, filePath: file.path, lineIndex, tr,
		numEl, checkbox: cb, textCell: editable, previewCell: preview, mdComp,
		originalLine, rootToken, groupKey, leftWrap,
	};

	renderMarkdown(store, rowRef).then(() => updateRowLayout(rowRef, text));

	preview.addEventListener("click", () => { preview.hide(); editable.show(); editable.focus(); });
	editable.addEventListener("blur", async () => {
		preview.show(); editable.hide();
		await renderMarkdown(store, rowRef);
	});

	editable.addEventListener("input", () => {
		store.markDirty();
		updateRowLayout(rowRef, editable.textContent ?? "");
		Save.scheduleAutosave(store);
	});

	cb.onchange = async () => {
		store.markDirty();
		await Save.saveRowImmediate(store, {
			filePath: file.path, lineIndex, originalLine: rowRef.originalLine,
			checked: cb.checked, text: editable.textContent ?? "",
		});
		rowRef.originalLine = buildLine(rowRef.originalLine, cb.checked, editable.textContent ?? "");
	};

	delBtn.onclick = async () => {
		try {
			store.setSaving(true);
			const st = store.ui.scroller?.scrollTop ?? 0;
			await store.withSquelch(async () => { await Move.deleteSubtree(store, rowRef); });
			await mountTable(store);
			if (store.ui.scroller) store.ui.scroller.scrollTop = st;
			new Notice("Task deleted.");
		} finally {
			store.setSaving(false);
		}
	};

	if (store.collapsedGroups.has(groupKey) || store.collapsedFiles.has(fileKey)) tr.style.display = "none";

	store.rowRefs.push(rowRef);
	store.rowById.set(id, rowRef);
	styleAndWireNumber(store, rowRef);
}

function updateRowLayout(row: RowRef, text: string) {
	const isMulti = /\n/.test(text || "") || (row.previewCell?.innerText || "").includes("\n");
	if (isMulti) row.tr.classList.add("multiline");
	else row.tr.classList.remove("multiline");
}

async function renderMarkdown(store: Store, row: RowRef) {
	const markdown = (row.textCell.textContent ?? "").trim();
	row.previewCell.empty();
	await MarkdownRenderer.render(store.app, markdown, row.previewCell, row.filePath, row.mdComp);
}

function addNewPlaceholder(store: Store, filePath: string, groupKey: string, fileKey: string) {
	const tr = store.ui.tbody.createEl("tr"); tr.classList.add("task-row", "task-new");

	const tdLeft = tr.createEl("td");
	tdLeft.classList.add("task-cell");
	Object.assign(tdLeft.style, { padding: "6px 8px", verticalAlign: "top", width: "100%" });

	const leftWrap = tdLeft.createDiv(); leftWrap.addClass("row-wrap");
	const plus = leftWrap.createSpan({ text: "+" }); plus.addClass("plus"); plus.title = "Add new task";

	const ghostCb = leftWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
	ghostCb.style.visibility = "hidden"; ghostCb.style.flex = "0 0 auto";

	const textWrap = leftWrap.createDiv(); Object.assign(textWrap.style, { flex: "1 1 auto", minWidth: "0" });

	const input = textWrap.createDiv({ text: "New" });
	input.addClass("task-edit", "placeholder");
	input.contentEditable = "true"; input.spellcheck = false;
	Object.assign(input.style, { whiteSpace: "pre-wrap", outline: "none" });

	const tdRight = tr.createEl("td");
	tdRight.classList.add("task-cell");
	Object.assign(tdRight.style, { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" });

	if (store.collapsedGroups.has(groupKey) || store.collapsedFiles.has(fileKey)) tr.style.display = "none";

	const clearPlaceholder = () => {
		if (input.classList.contains("placeholder")) { input.empty(); input.classList.remove("placeholder"); }
	};
	input.addEventListener("focus", clearPlaceholder);
	input.addEventListener("click", clearPlaceholder);
	input.addEventListener("blur", () => {
		const txt = (input.textContent ?? "").trim();
		if (!txt) { input.setText("New"); input.classList.add("placeholder"); }
	});

	const commit = async () => {
		const text = (input.textContent ?? "").trim();
		if (!text || input.classList.contains("placeholder")) return;
		await Save.createNewTaskAtEnd(store, filePath, text);
	};
	input.addEventListener("keydown", async (e: KeyboardEvent) => {
		if (e.key === "Enter") { e.preventDefault(); await commit(); }
	});
	input.addEventListener("input", async () => {
		if (!input.classList.contains("placeholder")) await commit();
	});

	tr.addEventListener("dragover", (e) => {
		if (!store.draggingId) return;
		e.preventDefault();
		clearHoverStyles(store);
		tr.classList.add("hover-top");
		store.hoverTarget = null;
	});
	tr.addEventListener("dragleave", () => { tr.classList.remove("hover-top"); });
	tr.addEventListener("drop", async (e) => {
		e.preventDefault(); tr.classList.remove("hover-top");
		if (!store.draggingId) return;
		const source = store.rowById.get(store.draggingId); store.draggingId = null;
		if (!source) return;
		const st = store.ui.scroller?.scrollTop ?? 0;
		try {
			await store.withSquelch(async () => { await Move.moveSubtreeToFileEnd(store, source, filePath, 1); })
			await mountTable(store);
			if (store.ui.scroller) store.ui.scroller.scrollTop = st;
			new Notice("Item moved.");
		} catch (err) { console.error(err); new Notice("Move failed."); }
	});

	store.newRowByFile.set(fileKey, tr);
}
