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
  rootKey: string; // unique per root task (file:path + line index of root)
};

type RowRef = {
  filePath: string;
  lineIndex: number;
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
    if (
      f instanceof TFolder &&
      f.path.split("/").some((s: string) => /planner/i.test(s))
    ) {
      planners.push(f);
    }
  }
  return planners;
}

function isInAnyPlanner(file: TFile, planners: TFolder[]) {
  return planners.some(
    (p: TFolder) => file.path === p.path || file.path.startsWith(p.path + "/"),
  );
}

/** Grouping:
 * key  = full path prefix up to (exclusive) the segment matching /planner/i
 * name = folder immediately before that segment (or "(root)" if none)
 */
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

/** Distinct hues via golden angle for stable, varied colors. */
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

  // color tuning
  private SAT = 78;            // saturation for “fully colored” root
  private L_BASE = 42;         // root lightness
  private L_STEP = 20;         // +20 per indent level
  private L_MAX = 90;          // cap

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

    // Single table, NO HEADER ROW
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
  }

  // ---------- render helpers ----------

  private clearTableBody() {
    this.rowRefs = [];
    this.tbody.empty();
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

  private addTaskRow(entry: TaskEntry) {
    const { file, lineIndex, originalLine, depth, rootKey } = entry;
    const m = originalLine.match(/^\s*([-*])\s\[( |x|X)\]\s(.+)$/);
    if (!m) return;

    const checked = m[2].toLowerCase() === "x";
    const text = m[3];

    const tr = this.tbody.createEl("tr");

    // Left cell: number + checkbox + editable text
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

    const depthSpan = leftWrap.createSpan({ text: String(depth) });
    depthSpan.style.flex = "0 0 auto";
    depthSpan.style.minWidth = "1.25em";

    // COLOR: root hue + per-indent lightness
    const hue = this.rootHueByKey.get(rootKey) ?? 0;
    const light = Math.min(this.L_MAX, this.L_BASE + (depth - 1) * this.L_STEP);
    depthSpan.style.color = hsl(hue, this.SAT, light);

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

    // Right cell: action icon on the far right
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

    this.rowRefs.push({
      filePath: file.path,
      lineIndex,
      checkbox: cb,
      textCell: editable,
      originalLine,
    });
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

    // Build groups + compute root relationships + assign hues
    const groups = new Map<string, GroupBucket>();
    this.tasksByFile.clear();
    this.rootHueByKey.clear();

    let rootIndexCounter = 0;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      const fileTasks: TaskEntry[] = [];

      // Track most recent root for depth=1
      let currentRootKey = "";
      // Optional stack to reset when a new root appears (robust to jumps in depth)
      let lastSeenDepth1Key = "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!taskRegex.test(line)) continue;

        const depth = getIndentDepth(line);

        if (depth === 1) {
          currentRootKey = `${file.path}::${i}`; // unique root id
          lastSeenDepth1Key = currentRootKey;

          // assign hue if first time we see this root
          if (!this.rootHueByKey.has(currentRootKey)) {
            this.rootHueByKey.set(currentRootKey, hueByIndex(rootIndexCounter++));
          }
        } else {
          // inherit from latest root in this file (best effort)
          if (!currentRootKey) currentRootKey = lastSeenDepth1Key || `${file.path}::first`;
        }

        const { key, name } = getGroupFromPath(file.path);
        if (!groups.has(key)) groups.set(key, { name, items: [] });

        const entry: TaskEntry = { file, lineIndex: i, originalLine: line, depth, rootKey: currentRootKey };
        groups.get(key)!.items.push(entry);
        fileTasks.push(entry);
      }

      if (fileTasks.length) this.tasksByFile.set(file.path, fileTasks);
    }

    // Render
    this.clearTableBody();
    for (const [, bucket] of groups) {
      this.addGroupSubheader(bucket.name);
      for (const entry of bucket.items) this.addTaskRow(entry);
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