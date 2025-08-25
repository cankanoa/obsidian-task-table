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
  id: string;        // unique (filePath::lineIndex)
  parentId?: string; // nearest shallower task in same group
};

type RowRef = {
  id: string;
  parentId?: string;
  depth: number;
  hasChildren: boolean;
  filePath: string;
  lineIndex: number;
  tr: HTMLTableRowElement;
  numEl: HTMLSpanElement;        // the number element (toggle/indicator)
  checkbox: HTMLInputElement;
  textCell: HTMLDivElement;
  originalLine: string;
};

type GroupBucket = {
  name: string;
  items: TaskEntry[];
};

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
  return planners.some(
    (p) => file.path === p.path || file.path.startsWith(p.path + "/"),
  );
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

/** Indent depth: root=1, then +1 roughly every 2 spaces (tabs count as 2). */
function getIndentDepth(line: string): number {
  const m = line.match(/^(\s*)[-*]\s\[[ xX]\]\s/);
  if (!m) return 1;
  const leading = m[1] ?? "";
  const spaces = leading.replace(/\t/g, "  ").length;
  return 1 + Math.floor(spaces / 2);
}

/** Distinct hues via golden angle for varied root colors. */
function hueByIndex(idx: number): number {
  const GOLDEN_ANGLE = 137.508;
  return (idx * GOLDEN_ANGLE) % 360;
}
function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

export class TaskTableView extends ItemView {
  private table!: HTMLTableElement;
  private tbody!: HTMLTableSectionElement;
  private rowRefs: RowRef[] = [];
  private tasksByFile = new Map<string, TaskEntry[]>();
  private rootHueByKey = new Map<string, number>(); // rootKey -> hue

  // collapse state & fast lookups
  private collapsed = new Set<string>();              // ids that are collapsed
  private childrenById = new Map<string, string[]>(); // id -> direct children ids
  private rowById = new Map<string, RowRef>();        // id -> rowRef

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
      (this.containerEl.querySelector(".view-content") as HTMLElement) ??
      this.containerEl;
    container.empty();

    const controls = container.createDiv({ cls: "task-table-controls" });
    const scanBtn = controls.createEl("button", { text: "Scan Tasks" });
    const saveBtn = controls.createEl("button", { text: "Save Changes" });
    scanBtn.style.marginRight = "0.5rem";
    scanBtn.onclick = () => this.scanTasks();
    saveBtn.onclick = () => this.saveEdits();

    const wrap = container.createDiv();
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "6px";
    wrap.style.overflow = "hidden";
    wrap.style.maxHeight = "520px";

    const scroller = wrap.createDiv();
    scroller.style.maxHeight = "520px";
    scroller.style.overflow = "auto";

    this.table = scroller.createEl("table");
    this.table.style.width = "100%";
    this.table.style.borderCollapse = "collapse";
    this.table.style.fontFamily = "var(--font-interface)";

    this.tbody = this.table.createEl("tbody");

    await this.scanTasks();
  }

  async onClose() {
    this.rowRefs = [];
    this.tasksByFile.clear();
    this.rootHueByKey.clear();
    this.collapsed.clear();
    this.childrenById.clear();
    this.rowById.clear();
  }

  // ---------- render helpers ----------

  private clearTableBody() {
    this.rowRefs = [];
    this.tbody.empty();
    // keep maps; they are rebuilt in scanTasks()
  }

  private addGroupSubheader(name: string) {
    const tr = this.tbody.createEl("tr");
    const td = tr.createEl("td", { text: name });
    td.colSpan = 2;
    td.style.padding = "6px 8px";
    td.style.fontWeight = "600";
    td.style.background = "var(--background-secondary)";
    td.style.borderBottom = "1px solid var(--background-modifier-border)";
  }

  private styleAndWireNumber(row: RowRef) {
  const { numEl, hasChildren, id, depth } = row;

  // Square box so rotation is centered & stable
  numEl.style.display = "inline-flex";
  numEl.style.alignItems = "center";
  numEl.style.justifyContent = "center";
  numEl.style.width = "1.5em";
  numEl.style.height = "1.5em";
  numEl.style.minWidth = "1.5em";
  numEl.style.flex = "0 0 auto";
  numEl.style.borderRadius = "4px"; // optional, looks nicer
  numEl.style.fontVariantNumeric = "tabular-nums";

  // Smooth rotation on center
  numEl.style.transition = "transform 120ms ease-out";
  numEl.style.transformOrigin = "50% 50%";

  // Weight: bolder if it has children; slightly lighter if not
  numEl.style.fontWeight = hasChildren ? "800" : "600";
  numEl.style.cursor = hasChildren ? "pointer" : "default";

  // Color (root hue + depth lightness)
  const rk = (this.rowById.get(id) as any)?.rootKey;
  const hue = this.rootHueByKey.get(rk) ?? 0;
  const light = Math.min(this.L_MAX, this.L_BASE + (depth - 1) * this.L_STEP);
  numEl.style.color = hsl(hue, this.SAT, light);

  // Toggle wiring
  if (hasChildren) {
    numEl.title = "Show/hide sub-tasks";
	numEl.style.fontWeight = "900";
    numEl.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleNode(id); };
    // Collapsed = rotate -90deg (left), Expanded = 0deg
    numEl.style.transform = this.collapsed.has(id) ? "rotate(-90deg)" : "rotate(0deg)";
  } else {
  	numEl.style.fontWeight = "100";
    numEl.removeAttribute("title");
    numEl.onclick = null as any;
    numEl.style.transform = "none";
  }
}

  private addTaskRow(entry: TaskEntry, hasChildren: boolean) {
    const { file, lineIndex, originalLine, depth, rootKey, id, parentId } = entry;
    const m = originalLine.match(/^\s*([-*])\s\[( |x|X)\]\s(.+)$/);
    if (!m) return;

    const checked = m[2].toLowerCase() === "x";
    const text = m[3];

    const tr = this.tbody.createEl("tr");

    // Left cell: number (toggle) + checkbox + editable text
    const tdLeft = tr.createEl("td");
    tdLeft.style.padding = "6px 8px";
    tdLeft.style.borderBottom = "1px solid var(--background-modifier-border)";
    tdLeft.style.verticalAlign = "middle";
    tdLeft.style.width = "100%";

    const leftWrap = tdLeft.createDiv();
    leftWrap.style.display = "flex";
    leftWrap.style.alignItems = "center";
    leftWrap.style.gap = "8px";
    leftWrap.style.minWidth = "0";

	const numEl = leftWrap.createSpan({ text: String(depth) });
	leftWrap.style.gap = "6px";

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

    // Right cell: open icon
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
    } as any;
    // @ts-expect-error stash rootKey via map lookup later
    (rowRef as any).rootKey = rootKey;

    this.rowRefs.push(rowRef);
    this.rowById.set(id, rowRef);

    // finalize number style/handlers
    this.styleAndWireNumber(rowRef);
  }

  // ---------- collapsing logic ----------

  private toggleNode(id: string) {
    const isCollapsed = this.collapsed.has(id);
    if (isCollapsed) this.expand(id);
    else this.collapse(id);
  }

  private collapse(id: string) {
    this.collapsed.add(id);
    const row = this.rowById.get(id);
    if (row) this.styleAndWireNumber(row);
    // hide all descendants
    for (const childId of this.getDescendants(id)) {
      const childRow = this.rowById.get(childId);
      if (childRow) childRow.tr.style.display = "none";
    }
  }

  private expand(id: string) {
    this.collapsed.delete(id);
    const row = this.rowById.get(id);
    if (row) this.styleAndWireNumber(row);
    // show descendants that don't have a collapsed ancestor
    for (const childId of this.getDescendants(id)) {
      if (!this.hasCollapsedAncestor(childId)) {
        const childRow = this.rowById.get(childId);
        if (childRow) childRow.tr.style.display = "";
      }
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

  // ---------- IO ----------

  private buildLine(originalLine: string, checked: boolean, text: string): string {
    const m = originalLine.match(/^(\s*[-*]\s)\[( |x|X)\]\s(.+)$/);
    if (m) return `${m[1]}[${checked ? "x" : " "}] ${text}`;
    return `- [${checked ? "x" : " "}] ${text}`;
  }

  private async scanTasks() {
    const planners = findPlannerFolders(this.app);
    if (planners.length === 0) {
      this.clearTableBody();
      new Notice('No folders matching "Planner" found.');
      return;
    }

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f: TFile) => isInAnyPlanner(f, planners));

    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    // rebuild all maps
    this.tasksByFile.clear();
    this.rootHueByKey.clear();
    this.childrenById.clear();
    this.rowById.clear();

    const groups = new Map<string, GroupBucket>();
    let rootIndexCounter = 0;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      const fileTasks: TaskEntry[] = [];

      let currentRootKey = "";
      let lastSeenDepth1Key = "";

      // First pass: collect entries with depth and rootKey
      const rawEntries: TaskEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!taskRegex.test(line)) continue;

        const depth = getIndentDepth(line);
        const id = `${file.path}::${i}`;

        if (depth === 1) {
          currentRootKey = `${file.path}::${i}`;
          lastSeenDepth1Key = currentRootKey;
          if (!this.rootHueByKey.has(currentRootKey)) {
            this.rootHueByKey.set(currentRootKey, hueByIndex(rootIndexCounter++));
          }
        } else if (!currentRootKey) {
          currentRootKey = lastSeenDepth1Key || `${file.path}::first`;
        }

        rawEntries.push({
          file, lineIndex: i, originalLine: line, depth, rootKey: currentRootKey, id,
        });
      }

      // Second pass: assign parentId using a depth stack
      const stack: TaskEntry[] = [];
      for (const e of rawEntries) {
        while (stack.length && stack[stack.length - 1].depth >= e.depth) {
          stack.pop();
        }
        e.parentId = stack.length ? stack[stack.length - 1].id : undefined;
        stack.push(e);
      }

      // Build children map and group
      for (const e of rawEntries) {
        if (e.parentId) {
          if (!this.childrenById.has(e.parentId)) this.childrenById.set(e.parentId, []);
          this.childrenById.get(e.parentId)!.push(e.id);
        }
        const { key, name } = getGroupFromPath(file.path);
        if (!groups.has(key)) groups.set(key, { name, items: [] });
        groups.get(key)!.items.push(e);
        fileTasks.push(e);
      }

      if (fileTasks.length) this.tasksByFile.set(file.path, fileTasks);
    }

    // Render
    this.clearTableBody();
    for (const [, bucket] of groups) {
      this.addGroupSubheader(bucket.name);
      for (const e of bucket.items) {
        const hasChildren = !!(this.childrenById.get(e.id)?.length);
        this.addTaskRow(e, hasChildren);
      }
    }

    // Apply collapsed state & indicator rotation
    for (const row of this.rowRefs) {
      if (this.hasCollapsedAncestor(row.id)) row.tr.style.display = "none";
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
        if (e.lineIndex >= 0 && e.lineIndex < lines.length) {
          lines[e.lineIndex] = e.newLine;
          touched++;
        }
      }
      await this.app.vault.modify(file, lines.join("\n"));
    }

    new Notice(`Task edits saved (${touched}).`);
    await this.scanTasks();
  }
}

export {};