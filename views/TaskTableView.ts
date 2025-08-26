// views/TaskTableView.ts
import {
  App,
  ItemView,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { TASK_TABLE_VIEW_TYPE } from "../main";

type TaskEntry = {
  file: TFile;
  lineIndex: number;
  originalLine: string;
  depth: number;
  rootKey: string;
  rootToken: string;       // color key (stable per session)
  id: string;              // filePath::lineIndex
  parentId?: string;
};

type RowRef = {
  id: string;
  parentId?: string;
  depth: number;
  hasChildren: boolean;
  filePath: string;
  lineIndex: number;
  tr: HTMLTableRowElement;
  numEl: HTMLSpanElement;      // number (also drag handle)
  checkbox: HTMLInputElement;
  textCell: HTMLDivElement;
  originalLine: string;
  rootToken: string;           // for color
  groupKey: string;            // for group collapse
};

type FileBucket = { filePath: string; fileName: string; items: TaskEntry[] };
type GroupBucket = { key: string; name: string; files: FileBucket[] };

function findPlannerFolders(app: App): TFolder[] {
  const planners: TFolder[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && f.path.split("/").some((s) => /planner/i.test(s))) {
      planners.push(f);
    }
  }
  return planners;
}
function isInAnyPlanner(file: TFile, planners: TFolder[]) {
  return planners.some((p) => file.path === p.path || file.path.startsWith(p.path + "/"));
}
function getGroupFromPath(path: string): { key: string; name: string } {
  const parts = path.split("/");
  const idx = parts.findIndex((seg) => /planner/i.test(seg));
  if (idx === -1) {
    const dirParts = parts.slice(0, Math.max(0, parts.length - 1));
    return { key: dirParts.join("/"), name: "(root)" };
  }
  const keyParts = parts.slice(0, idx);
  const name = keyParts.length ? keyParts[keyParts.length - 1] : "(root)";
  return { key: keyParts.join("/"), name };
}
/** Root token from a task line: normalized text after checkbox. */
function rootTokenFromLine(line: string): string {
  const m = line.match(/^\s*[-*]\s\[[ xX]\]\s(.+?)\s*$/);
  return (m?.[1] ?? line.trim()).toLowerCase();
}
/** Indent depth: root=1, +1 per 2 spaces (tabs=2). */
function getIndentDepth(line: string): number {
  const m = line.match(/^(\s*)[-*]\s\[[ xX]\]\s/);
  if (!m) return 1;
  const spaces = (m[1] ?? "").replace(/\t/g, "  ").length;
  return 1 + Math.floor(spaces / 2);
}
function hsl(h: number, s: number, l: number) { return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`; }

export class TaskTableView extends ItemView {
  private table!: HTMLTableElement;
  private tbody!: HTMLTableSectionElement;
  private scroller!: HTMLDivElement;

  private rowRefs: RowRef[] = [];
  private tasksByFile = new Map<string, TaskEntry[]>();
  private childrenById = new Map<string, string[]>();
  private rowById = new Map<string, RowRef>();
  private collapsed = new Set<string>(); // task rows collapse (per node)

  // collapsible headers
  private collapsedGroups = new Set<string>();  // groupKey
  private collapsedFiles = new Set<string>();   // filePath
  private groupHeaderRow = new Map<string, HTMLTableRowElement>();
  private fileHeaderRow = new Map<string, HTMLTableRowElement>();

  // drag state
  private draggingId: string | null = null;
  private hoverTarget: { id: string; mode: "on" | "before" | "after" } | null = null;

  // colors (stable per rootToken, randomized start)
  private hueByRootToken = new Map<string, number>();
  private hueOrder = 0;
  private readonly GOLDEN_ANGLE = 137.508;
  private readonly huePhase = Math.random() * 360;

  // color tuning
  private SAT = 78;
  private L_BASE = 42;
  private L_STEP = 20;
  private L_MAX = 90;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return TASK_TABLE_VIEW_TYPE; }
  getDisplayText() { return "Task Table"; }

  async onOpen() {
    const container =
      (this.containerEl.querySelector(".view-content") as HTMLElement) ?? this.containerEl;
    container.empty();

    // Fill window, no borders/radius
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100%";
    container.style.padding = "0";

    const controls = container.createDiv({ cls: "task-table-controls" });
    controls.style.padding = "8px 0";
    const scanBtn = controls.createEl("button", { text: "Scan Tasks" });
    const saveBtn = controls.createEl("button", { text: "Save Changes" });
    scanBtn.style.marginRight = "0.5rem";
    scanBtn.onclick = () => this.scanTasks();
    saveBtn.onclick = () => this.saveEdits();

    this.scroller = container.createDiv();
    this.scroller.style.flex = "1 1 auto";
    this.scroller.style.overflow = "auto";

    this.table = this.scroller.createEl("table");
    this.table.style.width = "100%";
    this.table.style.borderCollapse = "collapse";
    this.table.style.fontFamily = "var(--font-interface)";
    this.tbody = this.table.createEl("tbody");

    await this.scanTasks();
  }

  async onClose() {
    this.rowRefs = [];
    this.tasksByFile.clear();
    this.childrenById.clear();
    this.rowById.clear();
    this.draggingId = null;
    this.hoverTarget = null;
  }

  // ---------- helpers ----------

  private clearTableBody() {
    this.rowRefs = [];
    this.tbody.empty();
    this.groupHeaderRow.clear();
    this.fileHeaderRow.clear();
  }

  private makeChevronButton(expanded: boolean): HTMLButtonElement {
    // iOS-like chevron; no outline/focus ring
    const btn = document.createElement("button");
    btn.style.background = "transparent";
    btn.style.border = "none";
    btn.style.outline = "none";
    btn.style.boxShadow = "none";
    (btn.style as any).webkitTapHighlightColor = "transparent";
    btn.style.padding = "0 6px 0 2px";
    btn.style.cursor = "pointer";
    btn.style.lineHeight = "1";
    btn.tabIndex = -1; // prevent focus ring
    btn.onmousedown = (e) => e.preventDefault(); // avoid focusing

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.style.verticalAlign = "-1px";
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", "M4 6 L8 10 L12 6"); // down chevron
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    if (!expanded) svg.style.transform = "rotate(-90deg)";
    btn.appendChild(svg);

    (btn as any)._setExpanded = (isOpen: boolean) => {
      svg.style.transform = isOpen ? "rotate(0deg)" : "rotate(-90deg)";
    };

    return btn;
  }

  private addGroupSubheader(bucket: GroupBucket) {
    const tr = this.tbody.createEl("tr");
    const td = tr.createEl("td");
    td.colSpan = 2;
    td.style.padding = "8px 8px";
    td.style.fontWeight = "700";
    td.style.fontSize = "1.05rem";
    td.style.background = "transparent";
    td.style.borderBottom = "1px solid var(--background-modifier-border)";

    const wrap = td.createDiv();
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";

    const expanded = !this.collapsedGroups.has(bucket.key);
    const chev = this.makeChevronButton(expanded);
    wrap.appendChild(chev);

    const label = wrap.createSpan({ text: bucket.name });
    label.style.userSelect = "none";
    label.style.cursor = "pointer";

    const toggle = () => {
      const isCollapsed = this.collapsedGroups.has(bucket.key);
      if (isCollapsed) this.collapsedGroups.delete(bucket.key);
      else this.collapsedGroups.add(bucket.key);
      (chev as any)._setExpanded(!this.collapsedGroups.has(bucket.key));

      for (const fb of bucket.files) {
        const ftr = this.fileHeaderRow.get(fb.filePath);
        if (ftr) ftr.style.display = this.collapsedGroups.has(bucket.key) ? "none" : "";
        for (const r of this.rowRefs) {
          if (r.groupKey === bucket.key) {
            r.tr.style.display = this.collapsedGroups.has(bucket.key)
              ? "none"
              : (this.collapsedFiles.has(r.filePath) || this.hasCollapsedAncestor(r.id)) ? "none" : "";
          }
        }
      }
    };
    chev.onclick = toggle;
    label.onclick = toggle;

    this.groupHeaderRow.set(bucket.key, tr);
  }

  private addFileSubheader(fileBucket: FileBucket, groupKey: string) {
    const tr = this.tbody.createEl("tr");
    const td = tr.createEl("td");
    td.colSpan = 2;
    td.style.padding = "6px 8px";
    td.style.fontWeight = "600";
    td.style.fontSize = "1rem";
    td.style.background = "transparent";
    td.style.borderBottom = "1px solid var(--background-modifier-border)";

    const wrap = td.createDiv();
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";

    const expanded = !this.collapsedFiles.has(fileBucket.filePath) && !this.collapsedGroups.has(groupKey);
    const chev = this.makeChevronButton(expanded);
    wrap.appendChild(chev);

    const cleanName = fileBucket.fileName.replace(/\.md$/i, "");
    const label = wrap.createSpan({ text: cleanName });
    label.style.userSelect = "none";
    label.style.cursor = "pointer";

    const toggle = () => {
      const isCollapsed = this.collapsedFiles.has(fileBucket.filePath);
      if (isCollapsed) this.collapsedFiles.delete(fileBucket.filePath);
      else this.collapsedFiles.add(fileBucket.filePath);
      (chev as any)._setExpanded(!this.collapsedFiles.has(fileBucket.filePath));
      for (const r of this.rowRefs) {
        if (r.filePath === fileBucket.filePath) {
          r.tr.style.display =
            this.collapsedGroups.has(groupKey) || this.collapsedFiles.has(fileBucket.filePath) || this.hasCollapsedAncestor(r.id)
              ? "none" : "";
        }
      }
    };
    chev.onclick = toggle;
    label.onclick = toggle;

    if (this.collapsedGroups.has(groupKey)) tr.style.display = "none";
    this.fileHeaderRow.set(fileBucket.filePath, tr);
  }

  private styleAndWireNumber(row: RowRef) {
  const { numEl, hasChildren, id, depth, rootToken } = row;

  // number box (also drag handle)
  numEl.style.display = "inline-flex";
  numEl.style.alignItems = "center";
  numEl.style.justifyContent = "center";
  numEl.style.width = "1.5em";
  numEl.style.height = "1.5em";
  numEl.style.minWidth = "1.5em";
  numEl.style.flex = "0 0 auto";
  numEl.style.borderRadius = "4px";
  numEl.style.fontVariantNumeric = "tabular-nums";
  numEl.style.transition = "transform 120ms ease-out";
  numEl.style.transformOrigin = "50% 50%";
  numEl.style.fontWeight = hasChildren ? "900" : "100";
  numEl.style.cursor = "grab";

  // color per root
  const hue = this.hueByRootToken.get(rootToken) ?? 0;
  const light = Math.min(this.L_MAX, this.L_BASE + (depth - 1) * this.L_STEP);
  numEl.style.color = hsl(hue, this.SAT, light);

  // rotation to indicate open/closed
  if (hasChildren) {
    numEl.title = "Show/hide sub-tasks";
    numEl.style.transform = this.collapsed.has(id) ? "rotate(-90deg)" : "rotate(0deg)";
  } else {
    numEl.removeAttribute("title");
    numEl.style.transform = "none";
  }

  // DRAG on number
  numEl.setAttribute("draggable", "true");
  numEl.ondragstart = (e) => {
    this.draggingId = row.id;
    numEl.style.cursor = "grabbing";
    e.dataTransfer?.setData("text/plain", row.id);
    const ghost = document.createElement("div");
    ghost.textContent = "Moving…";
    ghost.style.padding = "2px 6px";
    ghost.style.background = "var(--background-secondary)";
    ghost.style.border = "1px solid var(--background-modifier-border)";
    document.body.appendChild(ghost);
    e.dataTransfer?.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  };
  numEl.ondragend = () => {
    numEl.style.cursor = "grab";
    this.draggingId = null;
    this.clearHoverStyles();
  };

  // Click toggles collapse (if parent)
  numEl.onclick = (e) => {
    if ((e as any).detail === 0) return; // ignore synthetic post-drag click
    if (hasChildren) { e.preventDefault(); e.stopPropagation(); this.toggleNode(id); }
  };

  // drop targets on row
  row.tr.addEventListener("dragover", (e) => this.onRowDragOver(e, row));
  row.tr.addEventListener("dragleave", () => this.onRowDragLeave(row));
  row.tr.addEventListener("drop", (e) => this.onRowDrop(e, row));
}

  private clearHoverStyles() {
    if (!this.hoverTarget) return;
    const targetRow = this.rowById.get(this.hoverTarget.id);
    if (!targetRow) { this.hoverTarget = null; return; }
    targetRow.tr.style.outline = "";
    targetRow.tr.style.outlineOffset = "";
    targetRow.tr.style.borderTop = "";
    targetRow.tr.style.borderBottom = "";
    this.hoverTarget = null;
  }
  private onRowDragOver(e: DragEvent, target: RowRef) {
    if (!this.draggingId || this.draggingId === target.id) return;
    e.preventDefault();
    const rect = target.tr.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const t = rect.height / 3;
    let mode: "before" | "after" | "on";
    if (y < t) mode = "before";
    else if (y > rect.height - t) mode = "after";
    else mode = "on";
    if (!this.hoverTarget || this.hoverTarget.id !== target.id || this.hoverTarget.mode !== mode) {
      this.clearHoverStyles();
      this.hoverTarget = { id: target.id, mode };
      if (mode === "on") {
        target.tr.style.outline = "2px solid var(--text-accent)";
        target.tr.style.outlineOffset = "-2px";
      } else if (mode === "before") {
        target.tr.style.borderTop = "2px solid var(--text-accent)";
      } else {
        target.tr.style.borderBottom = "2px solid var(--text-accent)";
      }
    }
  }
  private onRowDragLeave(_target: RowRef) {}

  private async onRowDrop(e: DragEvent, target: RowRef) {
    e.preventDefault();
    const sourceId = this.draggingId || e.dataTransfer?.getData("text/plain");
    const hover = this.hoverTarget;
    this.draggingId = null;
    this.clearHoverStyles();
    if (!sourceId || !hover) return;
    if (sourceId === target.id) return;

    const source = this.rowById.get(sourceId);
    if (!source) return;

    try {
      const st = this.scroller?.scrollTop ?? 0;
      if (hover.mode === "on") {
        await this.moveAsTopChild(source, target);
      } else {
        const after = hover.mode === "after";
        await this.moveBetweenWithMaxNeighborDepth(source, target, after);
      }
      await this.scanTasks();
      if (this.scroller) this.scroller.scrollTop = st;
      new Notice("Item moved.");
    } catch (err) {
      console.error(err);
      new Notice("Move failed.");
    }
  }

  private addTaskRow(entry: TaskEntry, hasChildren: boolean, groupKey: string) {
    const { file, lineIndex, originalLine, depth, rootToken, id, parentId } = entry;
    const m = originalLine.match(/^\s*([-*])\s\[( |x|X)\]\s(.+)$/);
    if (!m) return;

    const checked = m[2].toLowerCase() === "x";
    const text = m[3];

    const tr = this.tbody.createEl("tr");

    const tdLeft = tr.createEl("td");
    tdLeft.style.padding = "6px 8px";
    tdLeft.style.borderBottom = "1px solid var(--background-modifier-border)";
    tdLeft.style.verticalAlign = "middle";
    tdLeft.style.width = "100%";

    const leftWrap = tdLeft.createDiv();
    leftWrap.style.display = "flex";
    leftWrap.style.alignItems = "center";
    leftWrap.style.gap = "6px";
    leftWrap.style.minWidth = "0";

    const numEl = leftWrap.createSpan({ text: String(depth) });

    const cb = leftWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = checked;
    cb.style.flex = "0 0 auto";
    cb.style.verticalAlign = "middle";

    const editable = leftWrap.createDiv();
    editable.style.flex = "1 1 auto";
    editable.style.minWidth = "0";
    editable.style.wordBreak = "break-word";
    editable.style.whiteSpace = "pre-wrap";
    editable.contentEditable = "true";
    editable.spellcheck = false;
    editable.textContent = text;

    const tdRight = tr.createEl("td");
    tdRight.style.padding = "6px 8px";
    tdRight.style.borderBottom = "1px solid var(--background-modifier-border)";
    tdRight.style.textAlign = "right";
    tdRight.style.whiteSpace = "nowrap";
    tdRight.style.verticalAlign = "middle";

    const openBtn = tdRight.createEl("button", { title: "Open" });
    openBtn.textContent = "↗";
    openBtn.style.fontSize = "14px";
    openBtn.style.lineHeight = "1";
    openBtn.style.padding = "4px 8px";
    openBtn.onclick = async () => {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      const anyApp = this.app as any;
      const mdView = anyApp.workspace?.getActiveFileView?.();
      const editor = mdView?.editor ?? null;
      if (editor?.setCursor) editor.setCursor({ line: lineIndex, ch: 0 });
    };

    const rowRef: RowRef = {
      id,
      parentId,
      depth,
      hasChildren,
      filePath: file.path,
      lineIndex,
      tr,
      numEl,
      checkbox: cb,
      textCell: editable,
      originalLine,
      rootToken,
      groupKey,
    };

    if (this.collapsedGroups.has(groupKey) || this.collapsedFiles.has(file.path)) {
      tr.style.display = "none";
    }

    this.rowRefs.push(rowRef);
    this.rowById.set(id, rowRef);
    this.styleAndWireNumber(rowRef);
  }

  // ---------- node collapsing ----------

  private toggleNode(id: string) {
    if (this.collapsed.has(id)) this.expand(id);
    else this.collapse(id);
  }
  private collapse(id: string) {
    this.collapsed.add(id);
    const row = this.rowById.get(id);
    if (row) this.styleAndWireNumber(row);
    for (const childId of this.getDescendants(id)) {
      const childRow = this.rowById.get(childId);
      if (childRow) childRow.tr.style.display = "none";
    }
  }
  private expand(id: string) {
    this.collapsed.delete(id);
    const row = this.rowById.get(id);
    if (row) this.styleAndWireNumber(row);
    for (const childId of this.getDescendants(id)) {
      const r = this.rowById.get(childId);
      if (!r) continue;
      if (this.hasCollapsedAncestor(childId)) continue;
      if (this.collapsedGroups.has(r.groupKey) || this.collapsedFiles.has(r.filePath)) continue;
      r.tr.style.display = "";
    }
  }
  private hasCollapsedAncestor(id: string): boolean {
    let current = this.rowById.get(id);
    while (current?.parentId) {
      if (this.collapsed.has(current.parentId)) return true;
      current = this.rowById.get(current.parentId);
    }
    return false;
  }
  private getDescendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...(this.childrenById.get(id) || [])];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      const kids = this.childrenById.get(cur);
      if (kids && kids.length) stack.push(...kids);
    }
    return out;
  }

  // ---------- IO & DnD ----------

  private buildLine(originalLine: string, checked: boolean, text: string): string {
    const m = originalLine.match(/^(\s*[-*]\s)\[( |x|X)\]\s(.+)$/);
    if (m) return `${m[1]}[${checked ? "x" : " "}] ${text}`;
    return `- [${checked ? "x" : " "}] ${text}`;
  }
  private lineWithDepth(originalLine: string, newDepth: number): string {
    const m = originalLine.match(/^(\s*)([-*]\s\[[ xX]\]\s)(.+)$/);
    const indent = "  ".repeat(Math.max(0, newDepth - 1));
    if (m) return `${indent}${m[2]}${m[3]}`;
    const m2 = originalLine.match(/^\s*[-*]\s\[( |x|X)\]\s(.+)$/);
    const checked = m2 ? m2[1].toLowerCase() === "x" : false;
    const text = m2 ? m2[2] : originalLine.trim();
    return `${indent}- [${checked ? "x" : " "}] ${text}`;
  }
  private getPreviousRowInFile(ref: RowRef): RowRef | null {
    const idx = this.rowRefs.findIndex(r => r.id === ref.id);
    for (let i = idx - 1; i >= 0; i--) if (this.rowRefs[i].filePath === ref.filePath) return this.rowRefs[i];
    return null;
  }
  private getNextRowInFile(ref: RowRef): RowRef | null {
    const idx = this.rowRefs.findIndex(r => r.id === ref.id);
    for (let i = idx + 1; i < this.rowRefs.length; i++) if (this.rowRefs[i].filePath === ref.filePath) return this.rowRefs[i];
    return null;
  }

  private async moveAsTopChild(source: RowRef, parent: RowRef) {
    const newDepth = parent.depth + 1;
    const targetFilePath = parent.filePath;
    const insertAt = parent.lineIndex + 1;
    await this.relocateSubtree(source, targetFilePath, insertAt, newDepth);
  }

  private async moveBetweenWithMaxNeighborDepth(source: RowRef, target: RowRef, after: boolean) {
    const destFilePath = target.filePath;
    const aboveRow = after ? target : this.getPreviousRowInFile(target);
    const belowRow = after ? this.getNextRowInFile(target) : target;
    const newDepth = Math.max(aboveRow ? aboveRow.depth : 1, belowRow ? belowRow.depth : 1, 1);
    const insertAt = after ? target.lineIndex + 1 : target.lineIndex;
    await this.relocateSubtree(source, destFilePath, insertAt, newDepth);
  }

  /** Move a whole subtree (source and all descendants), adjusting indentation by depth delta. */
  private async relocateSubtree(source: RowRef, destFilePath: string, insertAt: number, newDepth: number) {
    const srcFile = this.app.vault.getAbstractFileByPath(source.filePath) as TFile;
    const destFile = this.app.vault.getAbstractFileByPath(destFilePath) as TFile;

    // Read source lines
    let srcContent = await this.app.vault.read(srcFile);
    let srcLines = srcContent.split("\n");

    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    // Determine subtree block [start..end] in source file
    const start = source.lineIndex;
    const srcDepth = getIndentDepth(srcLines[start] ?? source.originalLine);
    let end = start;
    for (let i = start + 1; i < srcLines.length; i++) {
      const ln = srcLines[i];
      if (!taskRegex.test(ln)) { continue; }
      const d = getIndentDepth(ln);
      if (d <= srcDepth) break; // next sibling or parent boundary
      end = i;
    }
    const blockLen = end - start + 1;

    // Build adjusted block with new depths
    const depthDelta = newDepth - srcDepth;
    const adjustedBlock = srcLines.slice(start, end + 1).map((ln) => {
      if (!taskRegex.test(ln)) return ln; // safety
      const d = getIndentDepth(ln);
      const nd = Math.max(1, d + depthDelta);
      return this.lineWithDepth(ln, nd);
    });

    // Remove from source
    srcLines.splice(start, blockLen);
    await this.app.vault.modify(srcFile, srcLines.join("\n"));

    // Adjust insert index if moving within same file and source was before insertion
    if (srcFile.path === destFile.path && start < insertAt) {
      insertAt -= blockLen;
    }

    // Destination lines
    let destLines: string[];
    if (srcFile.path === destFile.path) {
      destLines = srcLines;
    } else {
      const destContent = await this.app.vault.read(destFile);
      destLines = destContent.split("\n");
    }

    // Clamp + insert block
    insertAt = Math.max(0, Math.min(destLines.length, insertAt));
    destLines.splice(insertAt, 0, ...adjustedBlock);
    await this.app.vault.modify(destFile, destLines.join("\n"));
  }

  // ---------- scan / save ----------

  private async scanTasks() {
    const planners = findPlannerFolders(this.app);
    if (planners.length === 0) {
      this.clearTableBody();
      new Notice('No folders matching "Planner" found.');
      return;
    }

    const files = this.app.vault.getMarkdownFiles().filter((f: TFile) => isInAnyPlanner(f, planners));
    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    // rebuild maps
    this.tasksByFile.clear();
    this.childrenById.clear();
    this.rowById.clear();

    // Build groups → files → tasks
    const groupsMap = new Map<string, { name: string; files: Map<string, FileBucket> }>();

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      const fileTasks: TaskEntry[] = [];

      let currentRootKey = "";
      let currentRootToken = "";
      let lastSeenDepth1Key = "";
      let lastSeenRootToken = "";

      const rawEntries: TaskEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!taskRegex.test(line)) continue;

        const depth = getIndentDepth(line);
        const id = `${file.path}::${i}`;

        if (depth === 1) {
          currentRootKey = id;
          currentRootToken = rootTokenFromLine(line);
          lastSeenDepth1Key = currentRootKey;
          lastSeenRootToken = currentRootToken;

          if (!this.hueByRootToken.has(currentRootToken)) {
            const hue = (this.huePhase + this.hueOrder * this.GOLDEN_ANGLE) % 360;
            this.hueByRootToken.set(currentRootToken, hue);
            this.hueOrder++;
          }
        } else {
          if (!currentRootKey) currentRootKey = lastSeenDepth1Key || `${file.path}::first`;
          if (!currentRootToken) currentRootToken = lastSeenRootToken || "untitled-root";
        }

        rawEntries.push({ file, lineIndex: i, originalLine: line, depth, rootKey: currentRootKey, rootToken: currentRootToken, id });
      }

      // parentId via stack
      const stack: TaskEntry[] = [];
      for (const e of rawEntries) {
        while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
        e.parentId = stack.length ? stack[stack.length - 1].id : undefined;
        stack.push(e);
      }

      // build children
      for (const e of rawEntries) {
        if (e.parentId) {
          if (!this.childrenById.has(e.parentId)) this.childrenById.set(e.parentId, []);
          this.childrenById.get(e.parentId)!.push(e.id);
        }
        fileTasks.push(e);
      }

      if (fileTasks.length) this.tasksByFile.set(file.path, fileTasks);

      // register into group/file buckets
      const { key: gKey, name: gName } = getGroupFromPath(file.path);
      if (!groupsMap.has(gKey)) groupsMap.set(gKey, { name: gName, files: new Map() });
      const filesMap = groupsMap.get(gKey)!.files;
      if (!filesMap.has(file.path)) {
        const rawName = file.path.split("/").pop() ?? file.path;
        const fileName = rawName.replace(/\.md$/i, ""); // strip ".md"
        filesMap.set(file.path, { filePath: file.path, fileName, items: [] });
      }
      for (const e of rawEntries) filesMap.get(file.path)!.items.push(e);
    }

    // flatten into ordered buckets
    const groupBuckets: GroupBucket[] = [];
    for (const [gKey, gVal] of groupsMap) {
      const filesArr: FileBucket[] = Array.from(gVal.files.values());
      groupBuckets.push({ key: gKey, name: gVal.name, files: filesArr });
    }

    // render
    this.clearTableBody();

    for (const gb of groupBuckets) {
      this.addGroupSubheader(gb);
      for (const fb of gb.files) {
        this.addFileSubheader(fb, gb.key);
        for (const e of fb.items) {
          const hasChildren = !!(this.childrenById.get(e.id)?.length);
          this.addTaskRow(e, hasChildren, gb.key);
        }
      }
    }

    // bottom padding dummy row
    const padTr = this.tbody.createEl("tr");
    const padTd = padTr.createEl("td");
    padTd.colSpan = 2;
    padTd.style.padding = "12px 8px";

    // apply node collapse & recolor
    for (const row of this.rowRefs) {
      if (this.hasCollapsedAncestor(row.id)) row.tr.style.display = "none";
      if (this.collapsedGroups.has(row.groupKey) || this.collapsedFiles.has(row.filePath)) {
        row.tr.style.display = "none";
      }
      this.styleAndWireNumber(row);
    }

    const count = Array.from(this.tasksByFile.values()).reduce((n, a) => n + a.length, 0);
    new Notice(`Loaded ${count} task(s).`);
  }

  private async saveEdits() {
    if (!this.rowRefs.length || !this.tasksByFile.size) return;

    const byFile = new Map<string, { lineIndex: number; newLine: string }[]>();
    for (const ref of this.rowRefs) {
      const text = (ref.textCell.textContent ?? "").trim();
      const newLine = this.buildLine(ref.originalLine, ref.checkbox.checked, text);
      if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
      byFile.get(ref.filePath)!.push({ lineIndex: ref.lineIndex, newLine });
    }

    let touched = 0;
    for (const [path, edits] of byFile.entries()) {
      edits.sort((a, b) => a.lineIndex - b.lineIndex);
      const file = this.tasksByFile.get(path)?.[0]?.file;
      if (!file) continue;
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      for (const e of edits) {
        if (e.lineIndex >= 0 && e.lineIndex < lines.length) { lines[e.lineIndex] = e.newLine; touched++; }
      }
      await this.app.vault.modify(file, lines.join("\n"));
    }

    const st = this.scroller?.scrollTop ?? 0;
    new Notice(`Task edits saved (${touched}).`);
    await this.scanTasks();
    if (this.scroller) this.scroller.scrollTop = st;
  }
}

export {};