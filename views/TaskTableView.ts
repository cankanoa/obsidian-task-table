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

type TaskEntry = { file: TFile; lineIndex: number; originalLine: string };

type RowRef = {
  filePath: string;
  lineIndex: number;
  checkbox: HTMLInputElement;
  textCell: HTMLTableCellElement;
  originalLine: string;
};

type GroupBucket = {
  name: string;          // folder name before the Planner folder (or "(root)")
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

export class TaskTableView extends ItemView {
  private table!: HTMLTableElement;
  private tbody!: HTMLTableSectionElement;
  private rowRefs: RowRef[] = [];
  private tasksByFile = new Map<string, TaskEntry[]>();

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return TASK_TABLE_VIEW_TYPE; }
  getDisplayText() { return "Task Table"; }

  async onOpen() {
    const container =
      (this.containerEl.querySelector(".view-content") as HTMLElement) ??
      this.containerEl;
    container.empty();
    container.createEl("h2", { text: "Editable Tasks from Planner Folders" });

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

    // Build single table
    this.table = scroller.createEl("table");
    this.table.style.width = "100%";
    this.table.style.borderCollapse = "collapse";
    this.table.style.fontFamily = "var(--font-interface)";

    const thead = this.table.createEl("thead");
    const trh = thead.createEl("tr");
    // First header is intentionally blank (Order+Done live there)
    const headers = ["", "Task", "" /* actions */];
    headers.forEach((h) => {
      const th = trh.createEl("th", { text: h });
      th.style.position = "sticky";
      th.style.top = "0";
      th.style.background = "var(--background-primary)";
      th.style.padding = "6px 8px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
      th.style.textAlign = h === "Task" ? "left" : "center";
      th.style.whiteSpace = "nowrap";
    });

    this.tbody = this.table.createEl("tbody");

    await this.scanTasks();
  }

  async onClose() {
    this.rowRefs = [];
    this.tasksByFile.clear();
  }

  // ---------- render helpers ----------

  private clearTableBody() {
    this.rowRefs = [];
    this.tbody.empty();
  }

  private addGroupSubheader(name: string) {
    const tr = this.tbody.createEl("tr");
    const td = tr.createEl("td", { text: name });
    td.colSpan = 3;
    td.style.padding = "6px 8px";
    td.style.fontWeight = "600";
    td.style.background = "var(--background-secondary)";
    td.style.borderBottom = "1px solid var(--background-modifier-border)";
  }

  private addTaskRow(file: TFile, lineIndex: number, originalLine: string) {
    const m = originalLine.match(/^\s*([-*])\s\[( |x|X)\]\s(.+)$/);
    if (!m) return;

    const depth = getIndentDepth(originalLine);
    const checked = m[2].toLowerCase() === "x";
    const text = m[3];

    const tr = this.tbody.createEl("tr");

    // Col 1: depth number + checkbox (header for this col is blank)
    const tdOrder = tr.createEl("td");
    tdOrder.style.padding = "6px 8px";
    tdOrder.style.whiteSpace = "nowrap";
    tdOrder.style.borderBottom = "1px solid var(--background-modifier-border)";
    tdOrder.style.textAlign = "center";

    const depthSpan = tdOrder.createSpan({ text: String(depth) });
    depthSpan.style.display = "inline-block";
    depthSpan.style.minWidth = "1.25em";
    depthSpan.style.marginRight = "6px";

    const cb = tdOrder.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = checked;
    cb.style.verticalAlign = "middle";

    // Col 2: Task (editable)
    const tdTask = tr.createEl("td");
    tdTask.style.padding = "6px 8px";
    tdTask.style.borderBottom = "1px solid var(--background-modifier-border)";
    tdTask.style.wordBreak = "break-word";
    tdTask.contentEditable = "true";
    tdTask.spellcheck = false;
    tdTask.textContent = text;

    // Col 3: Actions
    const tdAction = tr.createEl("td");
    tdAction.style.padding = "6px 8px";
    tdAction.style.textAlign = "center";
    tdAction.style.whiteSpace = "nowrap";
    tdAction.style.borderBottom = "1px solid var(--background-modifier-border)";

    const openBtn = tdAction.createEl("button", { text: "Open" });
    openBtn.onclick = async () => {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      // try to place cursor on the line (best effort)
      const anyApp = this.app as any;
      const mdView = anyApp.workspace?.getActiveFileView?.();
      const editor = mdView?.editor ?? null;
      if (editor?.setCursor) editor.setCursor({ line: lineIndex, ch: 0 });
    };

    this.rowRefs.push({
      filePath: file.path,
      lineIndex,
      checkbox: cb,
      textCell: tdTask,
      originalLine,
    });
  }

  // ---------- IO ----------

  private buildLine(originalLine: string, checked: boolean, text: string): string {
    // Preserve original indent + bullet; replace checkbox/text
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

    const files = this.app.vault.getMarkdownFiles().filter((f: TFile) => isInAnyPlanner(f, planners));
    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    // Build groups first (keyed by path prefix), then render into one table
    const groups = new Map<string, GroupBucket>();
    this.tasksByFile.clear();

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      const fileTasks: TaskEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!taskRegex.test(line)) continue;

        const { key, name } = getGroupFromPath(file.path);
        if (!groups.has(key)) groups.set(key, { name, items: [] });

        const entry = { file, lineIndex: i, originalLine: line };
        groups.get(key)!.items.push(entry);
        fileTasks.push(entry);
      }

      if (fileTasks.length) this.tasksByFile.set(file.path, fileTasks);
    }

    // Render
    this.clearTableBody();
    for (const [, bucket] of groups) {
      this.addGroupSubheader(bucket.name);
      for (const entry of bucket.items) {
        this.addTaskRow(entry.file, entry.lineIndex, entry.originalLine);
      }
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