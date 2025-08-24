import { ItemView, WorkspaceLeaf, TFile, TFolder, Notice, App } from "obsidian";
import { TASK_TABLE_VIEW_TYPE } from "../main";

type TaskEntry = { file: TFile; lineIndex: number; originalLine: string };

function findPlannerFolders(app: App): TFolder[] {
  const planners: TFolder[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && f.path.split("/").some(s => s.toLowerCase().includes("planner"))) {
      planners.push(f);
    }
  }
  return planners;
}
function isInAnyPlanner(file: TFile, planners: TFolder[]) {
  return planners.some(p => file.path === p.path || file.path.startsWith(p.path + "/"));
}

export class TaskTableView extends ItemView {
  private ta: HTMLTextAreaElement | null = null;
  private tasksByFile = new Map<string, TaskEntry[]>();

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return TASK_TABLE_VIEW_TYPE; }
  getDisplayText() { return "Task Table"; }

  async onOpen() {
    const container = (this.containerEl.querySelector(".view-content") as HTMLElement) ?? this.containerEl;
    container.empty();
    container.createEl("h2", { text: "Editable Tasks from Planner Folders" });

    const row = container.createDiv();
    const scanBtn = row.createEl("button", { text: "Scan Tasks" });
    const saveBtn = row.createEl("button", { text: "Save Changes" });
    scanBtn.style.marginRight = "0.5rem";

    const host = container.createDiv({ cls: "task-table-editor" });
    host.style.height = "520px";
    host.style.display = "flex";
    host.style.flexDirection = "column";

    // Always use a textarea (reliable in CM6 Obsidian)
    this.ta = host.createEl("textarea");
    this.ta.style.width = "100%";
    this.ta.style.height = "100%";
    this.ta.style.fontFamily = "var(--font-monospace)";
    this.ta.style.whiteSpace = "pre";
    this.ta.wrap = "off";

    scanBtn.onclick = () => this.scanTasks();
    saveBtn.onclick = () => this.saveEdits();

    await this.scanTasks();
  }

  private getText(): string { return this.ta ? this.ta.value : ""; }
  private setText(t: string) {
    if (!this.ta) return;
    this.ta.value = t;
    // ensure it paints
    this.ta.dispatchEvent(new Event("input"));
  }

  private async scanTasks() {
    const planners = findPlannerFolders(this.app);
    if (planners.length === 0) {
      this.tasksByFile.clear();
      this.setText("");
      new Notice('No folders matching "Planner" found.');
      return;
    }

    const files = this.app.vault.getMarkdownFiles().filter(f => isInAnyPlanner(f, planners));
    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    const out: string[] = [];
    this.tasksByFile.clear();

    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      const fileTasks: TaskEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (taskRegex.test(lines[i])) fileTasks.push({ file, lineIndex: i, originalLine: lines[i] });
      }

      if (fileTasks.length) {
        out.push(`# File: ${file.path}`);
        for (const t of fileTasks) out.push(t.originalLine);
        this.tasksByFile.set(file.path, fileTasks);
        out.push("");
      }
    }

    if (out.length && out[out.length - 1] === "") out.pop();
    this.setText(out.join("\n"));

    const count = Array.from(this.tasksByFile.values()).reduce((n, a) => n + a.length, 0);
    new Notice(`Loaded ${count} task(s).`);
  }

  private async saveEdits() {
    if (!this.ta || !this.tasksByFile.size) return;

    const buf = this.getText().split("\n");
    const headerRegex = /^# File:\s(.+)$/;
    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    const editedByFile = new Map<string, string[]>();
    let current: string | null = null;

    for (const line of buf) {
      const hm = line.match(headerRegex);
      if (hm) { current = hm[1]; if (!editedByFile.has(current)) editedByFile.set(current, []); continue; }
      if (current && taskRegex.test(line)) editedByFile.get(current)!.push(line);
    }

    let touched = 0;
    for (const [path, originals] of this.tasksByFile.entries()) {
      const edits = editedByFile.get(path) ?? [];
      if (!edits.length) continue;

      const applyN = Math.min(originals.length, edits.length);
      if (applyN === 0) continue;

      const file = originals[0].file;
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");

      for (let i = 0; i < applyN; i++) {
        lines[originals[i].lineIndex] = edits[i];
      }
      await this.app.vault.modify(file, lines.join("\n"));
      touched += applyN;
    }

    new Notice(`Task edits saved (${touched}).`);
  }

  async onClose() {
    this.ta = null;
    this.tasksByFile.clear();
  }
}

export {};