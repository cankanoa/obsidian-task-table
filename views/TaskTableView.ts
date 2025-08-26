// views/TaskTableView.ts
import {
  App,
  ItemView,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  MarkdownRenderer,
  Component,
} from "obsidian";
import { TASK_TABLE_VIEW_TYPE } from "../main";

type TaskEntry = {
  file: TFile;
  lineIndex: number;
  originalLine: string;
  depth: number;
  rootKey: string;
  rootToken: string; // color key (stable per session)
  id: string; // filePath::lineIndex
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
  numEl: HTMLSpanElement; // number (also drag handle)
  checkbox: HTMLInputElement;
  textCell: HTMLDivElement; // plain-text editor (contentEditable)
  previewCell: HTMLDivElement; // rendered markdown
  mdComp: Component; // per-row component for postprocessors
  originalLine: string;
  rootToken: string; // for color
  groupKey: string; // for group collapse
  renderTimer?: number; // debounce handle
  leftWrap: HTMLDivElement; // align control container
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
function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

export class TaskTableView extends ItemView {
  private table!: HTMLTableElement;
  private tbody!: HTMLTableSectionElement;
  private scroller!: HTMLDivElement;

  // top status bar
  private statusBar!: HTMLDivElement;
  private statusIcon!: HTMLSpanElement;

  // state for status
  private savingDepth = 0; // >0 while writing
  private dirty = false; // true when local edits not yet saved
  private editsVersion = 0; // bump on input; used to reconcile dirty after save

  // suppress re-scan during our own writes to preserve focus
  private squelchScanDepth = 0;

  // suppress chevron animation during mass style updates (prevents re-triggering)
  private silentStylePass = false;

  private rowRefs: RowRef[] = [];
  private tasksByFile = new Map<string, TaskEntry[]>();
  private childrenById = new Map<string, string[]>();
  private rowById = new Map<string, RowRef>();
  private collapsed = new Set<string>();

  // collapsible headers
  private collapsedGroups = new Set<string>(); // groupKey
  private collapsedFiles = new Set<string>(); // filePath
  private groupHeaderRow = new Map<string, HTMLTableRowElement>();
  private fileHeaderRow = new Map<string, HTMLTableRowElement>();

  // placeholder rows for each file
  private newRowByFile = new Map<string, HTMLTableRowElement>();

  // drag state
  private draggingId: string | null = null;
  private hoverTarget: { id: string; mode: "on" | "before" | "after" } | null = null;

  // colors
  private hueByRootToken = new Map<string, number>();
  private hueOrder = 0;
  private readonly GOLDEN_ANGLE = 137.508;
  private readonly huePhase = Math.random() * 360;

  private SAT = 78;
  private L_BASE = 42;
  private L_STEP = 20;
  private L_MAX = 90;

  // disposers & autoscan/autosave
  private disposers: Array<() => void> = [];
  private scheduleRescan = this.debounce(() => this.scanTasks(), 300);
  private scheduleAutosave = this.debounce(() => this.saveEdits(), 600);

  // after creating a new item, focus it
  private pendingFocusId: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }
  getViewType() {
    return TASK_TABLE_VIEW_TYPE;
  }
  getDisplayText() {
    return "Task Table";
  }

  async onOpen() {
    const container =
      (this.containerEl.querySelector(".view-content") as HTMLElement) ?? this.containerEl;
    container.empty();

    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100%";
    container.style.padding = "0";

    // Top status bar
    this.statusBar = container.createDiv();
    this.statusBar.style.flex = "0 0 auto";
    this.statusBar.style.display = "flex";
    this.statusBar.style.alignItems = "center";
    this.statusBar.style.justifyContent = "flex-end";
    this.statusBar.style.height = "28px";
    this.statusBar.style.padding = "0 12px 0 8px"; // slight right margin so it's not glued to edge
    this.statusBar.style.borderBottom = "1px solid var(--background-modifier-border)";

    this.statusIcon = this.statusBar.createSpan();
    this.statusIcon.setAttr("aria-label", "save status");
    this.statusIcon.style.display = "inline-flex";
    this.statusIcon.style.alignItems = "center";
    this.statusIcon.style.justifyContent = "center";
    this.statusIcon.style.width = "18px";
    this.statusIcon.style.height = "18px";
    this.statusIcon.style.fontSize = "14px";
    this.statusIcon.style.opacity = "0.9";
    this.statusIcon.style.background = "transparent";
    this.statusIcon.style.marginRight = "6px";
    this.updateStatusIcon();

    // scroller/table
    this.scroller = container.createDiv();
    this.scroller.style.flex = "1 1 auto";
    this.scroller.style.overflow = "auto";

    this.table = this.scroller.createEl("table");
    this.table.style.width = "100%";
    this.table.style.borderCollapse = "collapse";
    this.table.style.fontFamily = "var(--font-interface)";
    this.tbody = this.table.createEl("tbody");

    const ttStyle = document.createElement("style");
    ttStyle.textContent = `
/* markdown tightening */
.tt-md { padding: 0 !important; }
.tt-md p,
.tt-md ul,
.tt-md ol,
.tt-md blockquote,
.tt-md h1, .tt-md h2, .tt-md h3, .tt-md h4, .tt-md h5, .tt-md h6,
.tt-md .callout,
.tt-md .internal-embed,
.tt-md .media-embed { margin: 0 !important; }
.tt-md ul, .tt-md ol { padding-inline-start: 1.1em; }

/* row baseline to prevent drag hover border shifting layout */
.task-row { border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
.task-row.hover-top { border-top-color: var(--text-accent); }
.task-row.hover-bottom { border-bottom-color: var(--text-accent); }

/* show normal dividing lines between rows */
.task-cell { border-bottom: 1px solid var(--background-modifier-border); }

/* placeholder new-row styling */
.task-new .placeholder { color: var(--text-muted); }
.task-new .plus {
  display:inline-flex; align-items:center; justify-content:center;
  width:1.5em; min-width:1.5em; height:1.5em; border-radius:4px;
  font-weight:700; opacity:0.7; user-select:none;
}

/* keep controls pinned to top always (no vertical shifting) */
.row-wrap { display:flex; align-items:flex-start; gap:6px; min-width:0; }

/* fix top alignment for controls regardless of multiline content */
.row-wrap .num, .row-wrap input[type="checkbox"] { margin-top: 2px; }

/* consistent font in edit vs preview */
.task-edit, .task-preview { font-size: var(--font-ui-medium, 14px); line-height: 1.4; }
`;
    document.head.appendChild(ttStyle);
    this.disposers.push(() => ttStyle.remove());

    await this.scanTasks();

    // auto-scan: vault changes that touch Planner files, but skip while we are saving
    const vault = this.app.vault;
    const onFsChange = async (af: any) => {
      if (this.squelchScanDepth > 0) return;
      if (!(af instanceof TFile)) return;
      const planners = findPlannerFolders(this.app);
      if (isInAnyPlanner(af, planners)) this.scheduleRescan();
    };
    const onDelete = async (af: any) => {
      if (this.squelchScanDepth > 0) return;
      if (!(af instanceof TFile)) return;
      const planners = findPlannerFolders(this.app);
      if (isInAnyPlanner(af, planners)) this.scheduleRescan();
    };

    vault.on("modify", onFsChange);
    vault.on("create", onFsChange);
    vault.on("rename", onFsChange);
    vault.on("delete", onDelete);

    const onFileOpen = () => this.scheduleRescan();
    this.app.workspace.on("file-open", onFileOpen);

    this.disposers.push(() => vault.off("modify", onFsChange));
    this.disposers.push(() => vault.off("create", onFsChange));
    this.disposers.push(() => vault.off("rename", onFsChange));
    this.disposers.push(() => vault.off("delete", onDelete));
    this.disposers.push(() => this.app.workspace.off("file-open", onFileOpen));
  }

  async onClose() {
    // unload per-row components
    for (const r of this.rowRefs) r.mdComp?.unload?.();
    this.rowRefs = [];
    this.tasksByFile.clear();
    this.childrenById.clear();
    this.rowById.clear();
    this.draggingId = null;
    this.hoverTarget = null;
    for (const d of this.disposers) {
      try {
        d();
      } catch {}
    }
    this.disposers = [];
  }

  // ---------- helpers ----------

  private debounce<T extends (...a: any[]) => any>(fn: T, wait: number) {
    let t: number | undefined;
    return (...args: Parameters<T>) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fn(...args), wait);
    };
  }

  private updateStatusIcon() {
    this.statusIcon.style.display = "inline-block";
    this.statusIcon.style.lineHeight = "1";
    this.statusIcon.style.margin = "0";
    this.statusIcon.style.padding = "0";
    if (this.savingDepth > 0 || this.dirty) {
      this.statusIcon.style.fontSize = "22px";
      this.statusIcon.textContent = "⟳";
      this.statusIcon.title = this.savingDepth > 0 ? "Saving…" : "Unsaved edits…";
    } else {
      this.statusIcon.style.fontSize = "18px";
      this.statusIcon.textContent = "✓";
      this.statusIcon.title = "Saved";
    }
  }
  private setSaving(on: boolean) {
    this.savingDepth = Math.max(0, this.savingDepth + (on ? 1 : -1));
    this.updateStatusIcon();
  }
  private markDirty() {
    this.dirty = true;
    this.editsVersion++;
    this.updateStatusIcon();
  }
  private markCleanIfVersion(versionAtStart: number) {
    if (this.editsVersion === versionAtStart) {
      this.dirty = false;
      this.updateStatusIcon();
    }
  }
  private async withSquelch<T>(fn: () => Promise<T>): Promise<T> {
    this.squelchScanDepth++;
    try {
      return await fn();
    } finally {
      this.squelchScanDepth = Math.max(0, this.squelchScanDepth - 1);
    }
  }

  private clearTableBody() {
    // unload markdown components to clean postprocessors
    for (const r of this.rowRefs) r.mdComp?.unload?.();
    this.rowRefs = [];
    this.tbody.empty();
    this.groupHeaderRow.clear();
    this.fileHeaderRow.clear();
    this.newRowByFile.clear();
  }

  private makeChevronButton(expanded: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.style.background = "transparent";
    btn.style.border = "none";
    btn.style.outline = "none";
    btn.style.boxShadow = "none";
    (btn.style as any).webkitTapHighlightColor = "transparent";
    btn.style.padding = "0 6px 0 2px";
    btn.style.cursor = "pointer";
    btn.style.lineHeight = "1";
    btn.tabIndex = -1;
    btn.onmousedown = (e) => e.preventDefault();

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.style.verticalAlign = "-1px";
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", "M4 6 L8 10 L12 6");
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
    td.classList.add("task-cell");
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
        // hide/show placeholder rows inside group
        const newTr = this.newRowByFile.get(fb.filePath);
        if (newTr) newTr.style.display = this.collapsedGroups.has(bucket.key) ? "none" : "";
        for (const r of this.rowRefs) {
          if (r.groupKey === bucket.key) {
            r.tr.style.display = this.collapsedGroups.has(bucket.key)
              ? "none"
              : this.collapsedFiles.has(r.filePath) || this.hasCollapsedAncestor(r.id)
              ? "none"
              : "";
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
    td.classList.add("task-cell");
    td.style.padding = "6px 8px";
    td.style.fontWeight = "500"; // slightly less bold
    td.style.fontSize = "1rem";
    td.style.background = "transparent";
    td.style.borderBottom = "1px solid var(--background-modifier-border)";

    const wrap = td.createDiv();
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";

    const expanded =
      !this.collapsedFiles.has(fileBucket.filePath) && !this.collapsedGroups.has(groupKey);
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
            this.collapsedGroups.has(groupKey) ||
            this.collapsedFiles.has(fileBucket.filePath) ||
            this.hasCollapsedAncestor(r.id)
              ? "none"
              : "";
        }
      }
      // toggle placeholder for this file
      const newTr = this.newRowByFile.get(fileBucket.filePath);
      if (newTr) {
        newTr.style.display =
          this.collapsedGroups.has(groupKey) || this.collapsedFiles.has(fileBucket.filePath)
            ? "none"
            : "";
      }
    };
    chev.onclick = toggle;
    label.onclick = toggle;

    if (this.collapsedGroups.has(groupKey)) tr.style.display = "none";
    this.fileHeaderRow.set(fileBucket.filePath, tr);
  }

  private styleAndWireNumber(row: RowRef) {
    const { numEl, hasChildren, id, depth, rootToken } = row;

    numEl.classList.add("num");
    numEl.style.display = "inline-flex";
    numEl.style.alignItems = "center";
    numEl.style.justifyContent = "center";
    numEl.style.width = "1.5em";
    numEl.style.height = "1.5em";
    numEl.style.minWidth = "1.5em";
    numEl.style.flex = "0 0 auto";
    numEl.style.borderRadius = "4px";
    numEl.style.fontVariantNumeric = "tabular-nums";
    numEl.style.transformOrigin = "50% 50%";
    numEl.style.fontWeight = hasChildren ? "900" : "100";
    numEl.style.cursor = "grab";
    numEl.style.transition = this.silentStylePass ? "none" : "transform 120ms ease-out";

    const hue = this.hueByRootToken.get(rootToken) ?? 0;
    const light = Math.min(this.L_MAX, this.L_BASE + (depth - 1) * this.L_STEP);
    numEl.style.color = hsl(hue, this.SAT, light);

    if (hasChildren) {
      numEl.title = "Show/hide sub-tasks";
      numEl.style.transform = this.collapsed.has(id) ? "rotate(-90deg)" : "rotate(0deg)";
    } else {
      numEl.removeAttribute("title");
      numEl.style.transform = "none";
    }

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

    numEl.onclick = (e) => {
      if ((e as any).detail === 0) return;
      if (hasChildren) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleNode(id);
      }
    };

    row.tr.addEventListener("dragover", (e) => this.onRowDragOver(e, row));
    row.tr.addEventListener("dragleave", () => this.onRowDragLeave(row));
    row.tr.addEventListener("drop", (e) => this.onRowDrop(e, row));
  }

  private clearHoverStyles() {
    if (!this.hoverTarget) return;
    const targetRow = this.rowById.get(this.hoverTarget.id);
    if (!targetRow) {
      this.hoverTarget = null;
      return;
    }
    targetRow.tr.classList.remove("hover-top", "hover-bottom");
    targetRow.tr.style.outline = "";
    targetRow.tr.style.outlineOffset = "";
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
        target.tr.style.outline = "2px solid var(--text-accent)"; // outline doesn't affect layout
        target.tr.style.outlineOffset = "-2px";
      } else if (mode === "before") {
        target.tr.classList.add("hover-top");
      } else {
        target.tr.classList.add("hover-bottom");
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
      await this.withSquelch(async () => {
        if (hover.mode === "on") {
          await this.moveAsTopChild(source, target);
        } else {
          const after = hover.mode === "after";
          await this.moveBetweenWithMaxNeighborDepth(source, target, after);
        }
      });
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
    tr.classList.add("task-row");

    const tdLeft = tr.createEl("td");
    tdLeft.classList.add("task-cell");
    tdLeft.style.padding = "6px 8px";
    tdLeft.style.verticalAlign = "top";
    tdLeft.style.width = "100%";

    const leftWrap = tdLeft.createDiv();
    leftWrap.addClass("row-wrap"); // alignment controlled by CSS

    const numEl = leftWrap.createSpan({ text: String(depth) });
    numEl.classList.add("num");

    const cb = leftWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = checked;
    cb.style.flex = "0 0 auto";

    // EDITOR (contentEditable) + PREVIEW (MarkdownRenderer)
    const textWrap = leftWrap.createDiv();
    textWrap.style.flex = "1 1 auto";
    textWrap.style.minWidth = "0";
    textWrap.style.position = "relative";
    textWrap.style.wordBreak = "break-word";

    const editable = textWrap.createDiv();
    editable.addClass("task-edit");
    editable.style.display = "none"; // preview-first
    editable.style.whiteSpace = "pre-wrap";
    editable.style.outline = "none";
    editable.style.minWidth = "0";
    editable.contentEditable = "true";
    editable.spellcheck = false;
    editable.textContent = text;

    const preview = textWrap.createDiv();
    preview.addClass("markdown-preview-view", "tt-md", "task-preview");
    preview.style.minWidth = "0";
    preview.style.cursor = "text";
    preview.style.padding = "0";

    const tdRight = tr.createEl("td");
    tdRight.classList.add("task-cell");
    tdRight.style.padding = "6px 8px";
    tdRight.style.textAlign = "right";
    tdRight.style.whiteSpace = "nowrap";
    tdRight.style.verticalAlign = "top";

    // open
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

    // delete
    const delBtn = tdRight.createEl("button", { title: "Delete task & subtasks" });
    delBtn.textContent = "🗑";
    delBtn.style.fontSize = "14px";
    delBtn.style.lineHeight = "1";
    delBtn.style.padding = "4px 8px";
    delBtn.style.marginLeft = "6px";

    // per-row component for markdown postprocessors
    const mdComp = new Component();
    this.addChild(mdComp);

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
      previewCell: preview,
      mdComp,
      originalLine,
      rootToken,
      groupKey,
      leftWrap,
    };

    // initial render + layout
    this.renderMarkdown(rowRef).then(() => this.updateRowLayout(rowRef, text));

    // toggle: preview -> edit on click
    preview.addEventListener("click", () => {
      preview.hide();
      editable.show();
      // place caret at end
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      editable.focus();
    });

    // edit handlers
    editable.addEventListener("input", () => {
      this.markDirty();
      this.updateRowLayout(rowRef, editable.textContent ?? "");
      // live re-render (debounced) while typing but keep editor visible
      this.debounceRender(rowRef, 200);
      this.scheduleAutosave();
    });
    editable.addEventListener("blur", () => {
      preview.show();
      editable.hide();
      this.renderMarkdown(rowRef);
    });

    // quick save on checkbox change (no re-render)
    cb.onchange = async () => {
      this.markDirty();
      await this.saveRowImmediate({
        filePath: file.path,
        lineIndex,
        originalLine: rowRef.originalLine,
        checkbox: cb,
        text: editable.textContent ?? "",
      });
      rowRef.originalLine = this.buildLine(
        rowRef.originalLine,
        cb.checked,
        editable.textContent ?? ""
      );
    };

    delBtn.onclick = async () => {
      try {
        this.setSaving(true);
        const st = this.scroller?.scrollTop ?? 0;
        await this.withSquelch(async () => {
          await this.deleteSubtree(rowRef);
        });
        await this.scanTasks(); // delete requires re-render
        if (this.scroller) this.scroller.scrollTop = st;
        new Notice("Task deleted.");
      } catch (e) {
        console.error(e);
        new Notice("Delete failed.");
      } finally {
        this.setSaving(false);
      }
    };

    if (this.collapsedGroups.has(groupKey) || this.collapsedFiles.has(file.path)) {
      tr.style.display = "none";
    }

    this.rowRefs.push(rowRef);
    this.rowById.set(id, rowRef);
    this.styleAndWireNumber(rowRef);
  }

  // Keep single-line centered; multiline pinned to top (controls already fixed to top)
  private updateRowLayout(row: RowRef, text: string) {
    const isMulti = /\n/.test(text || "") || (row.previewCell?.innerText || "").includes("\n");
    if (isMulti) row.tr.classList.add("multiline");
    else row.tr.classList.remove("multiline");
  }

  // Render markdown for a row using Obsidian's renderer
  private async renderMarkdown(row: RowRef) {
    const markdown = (row.textCell.textContent ?? "").trim();
    row.previewCell.empty();
    await MarkdownRenderer.render(this.app, markdown, row.previewCell, row.filePath, row.mdComp);
  }

  // Debounced live re-render during typing (keeps editor visible)
  private debounceRender(row: RowRef, wait = 200) {
    if (row.renderTimer) window.clearTimeout(row.renderTimer);
    row.renderTimer = window.setTimeout(() => this.renderMarkdown(row), wait);
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
    const idx = this.rowRefs.findIndex((r) => r.id === ref.id);
    for (let i = idx - 1; i >= 0; i--) if (this.rowRefs[i].filePath === ref.filePath) return this.rowRefs[i];
    return null;
  }
  private getNextRowInFile(ref: RowRef): RowRef | null {
    const idx = this.rowRefs.findIndex((r) => r.id === ref.id);
    for (let i = idx + 1; i < this.rowRefs.length; i++)
      if (this.rowRefs[i].filePath === ref.filePath) return this.rowRefs[i];
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

  private async relocateSubtree(
    source: RowRef,
    destFilePath: string,
    insertAt: number,
    newDepth: number
  ) {
    const srcFile = this.app.vault.getAbstractFileByPath(source.filePath) as TFile;
    const destFile = this.app.vault.getAbstractFileByPath(destFilePath) as TFile;

    let srcContent = await this.app.vault.read(srcFile);
    let srcLines = srcContent.split("\n");

    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    const start = source.lineIndex;
    const srcDepth = getIndentDepth(srcLines[start] ?? source.originalLine);
    let end = start;
    for (let i = start + 1; i < srcLines.length; i++) {
      const ln = srcLines[i];
      if (!taskRegex.test(ln)) {
        break;
      }
      const d = getIndentDepth(ln);
      if (d <= srcDepth) break;
      end = i;
    }
    const blockLen = end - start + 1;

    const depthDelta = newDepth - srcDepth;
    const adjustedBlock = srcLines.slice(start, end + 1).map((ln) => {
      if (!taskRegex.test(ln)) return ln;
      const d = getIndentDepth(ln);
      const nd = Math.max(1, d + depthDelta);
      return this.lineWithDepth(ln, nd);
    });

    // Remove from source (squelch rescans)
    await this.withSquelch(async () => {
      srcLines.splice(start, blockLen);
      await this.app.vault.modify(srcFile, srcLines.join("\n"));
    });

    if (srcFile.path === destFile.path && start < insertAt) insertAt -= blockLen;

    let destLines: string[];
    if (srcFile.path === destFile.path) {
      destLines = srcLines;
    } else {
      const destContent = await this.app.vault.read(destFile);
      destLines = destContent.split("\n");
    }

    insertAt = Math.max(0, Math.min(destLines.length, insertAt));
    await this.withSquelch(async () => {
      destLines.splice(insertAt, 0, ...adjustedBlock);
      await this.app.vault.modify(destFile, destLines.join("\n"));
    });
  }

  // ---------- scan / save ----------

  private async scanTasks() {
    const planners = findPlannerFolders(this.app);
    if (planners.length === 0) {
      this.clearTableBody();
      return;
    }

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f: TFile) => isInAnyPlanner(f, planners));
    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    this.tasksByFile.clear();
    this.childrenById.clear();
    this.rowById.clear();
    this.newRowByFile.clear();

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

        rawEntries.push({
          file,
          lineIndex: i,
          originalLine: line,
          depth,
          rootKey: currentRootKey,
          rootToken: currentRootToken,
          id,
        });
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
        const fileName = rawName.replace(/\.md$/i, "");
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
          const hasChildren = !!this.childrenById.get(e.id)?.length;
          this.addTaskRow(e, hasChildren, gb.key);
        }
        // always add a placeholder "New" row at end of each file
        this.addNewPlaceholderRow(fb.filePath, gb.key);
      }
    }

    // bottom padding dummy row
    const padTr = this.tbody.createEl("tr");
    const padTd = padTr.createEl("td");
    padTd.colSpan = 2;
    padTd.style.padding = "12px 8px";

    // apply node collapse & recolor, silently to avoid chevron transition re-trigger
    this.silentStylePass = true;
    for (const row of this.rowRefs) {
      if (this.hasCollapsedAncestor(row.id)) row.tr.style.display = "none";
      if (this.collapsedGroups.has(row.groupKey) || this.collapsedFiles.has(row.filePath)) {
        row.tr.style.display = "none";
      }
      this.styleAndWireNumber(row);
    }
    this.silentStylePass = false;

    // focus a newly created item if requested
    if (this.pendingFocusId) {
      const ref = this.rowById.get(this.pendingFocusId);
      this.pendingFocusId = null;
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
  }

  // Save currently rendered edits (batch). No re-render here → caret preserved.
  private async saveEdits() {
    if (!this.rowRefs.length || !this.tasksByFile.size) return;

    const versionAtStart = this.editsVersion;

    const byFile = new Map<string, { lineIndex: number; newLine: string }[]>();
    for (const ref of this.rowRefs) {
      const text = (ref.textCell.textContent ?? "").trim();
      const newLine = this.buildLine(ref.originalLine, ref.checkbox.checked, text);
      if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
      byFile.get(ref.filePath)!.push({ lineIndex: ref.lineIndex, newLine });
    }

    try {
      this.setSaving(true);
      await this.withSquelch(async () => {
        for (const [path, edits] of byFile.entries()) {
          edits.sort((a, b) => a.lineIndex - b.lineIndex);
          const file = this.tasksByFile.get(path)?.[0]?.file;
          if (!file) continue;
          const content = await this.app.vault.read(file);
          const lines = content.split("\n");
          for (const e of edits) {
            if (e.lineIndex >= 0 && e.lineIndex < lines.length) {
              lines[e.lineIndex] = e.newLine;
            }
          }
          await this.app.vault.modify(file, lines.join("\n"));
        }
      });
      // update in-memory originals so subsequent saves are idempotent
      for (const ref of this.rowRefs) {
        const text = (ref.textCell.textContent ?? "").trim();
        ref.originalLine = this.buildLine(ref.originalLine, ref.checkbox.checked, text);
        // refresh preview to reflect save if in preview mode
        if (ref.previewCell.isShown()) this.renderMarkdown(ref);
      }
      this.markCleanIfVersion(versionAtStart);
    } catch (e) {
      console.error(e);
    } finally {
      this.setSaving(false);
    }
  }

  // Save just one row (checkbox change / blur-safe if you add later). No re-render.
  private async saveRowImmediate(args: {
    filePath: string;
    lineIndex: number;
    originalLine: string;
    checkbox: HTMLInputElement;
    text: string;
  }) {
    const { filePath, lineIndex, originalLine, checkbox, text } = args;
    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    if (!file) return;

    try {
      this.setSaving(true);
      await this.withSquelch(async () => {
        const content = await this.app.vault.read(file);
        const lines = content.split("\n");
        if (lineIndex < 0 || lineIndex >= lines.length) return;
        const newLine = this.buildLine(originalLine, checkbox.checked, (text ?? "").trim());
        if (lines[lineIndex] === newLine) return;
        lines[lineIndex] = newLine;
        await this.app.vault.modify(file, lines.join("\n"));
      });
    } finally {
      this.setSaving(false);
      // do NOT mark clean here; batch save may still be pending for other edits
    }
  }

  // Delete a row and its indented descendants; then file is saved.
  private async deleteSubtree(row: RowRef) {
    const srcFile = this.app.vault.getAbstractFileByPath(row.filePath) as TFile;
    if (!srcFile) return;

    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    const content = await this.app.vault.read(srcFile);
    const lines = content.split("\n");
    const start = row.lineIndex;
    if (start < 0 || start >= lines.length) return;

    const base = lines[start] ?? row.originalLine;
    if (!taskRegex.test(base)) return;

    const srcDepth = getIndentDepth(base);
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!taskRegex.test(ln)) break;
      const d = getIndentDepth(ln);
      if (d <= srcDepth) break;
      end = i;
    }

    const blockLen = end - start + 1;
    lines.splice(start, blockLen);
    await this.app.vault.modify(srcFile, lines.join("\n"));
  }

  // ---------- Placeholder "New" row at end of each file ----------

  private addNewPlaceholderRow(filePath: string, groupKey: string) {
    const tr = this.tbody.createEl("tr");
    tr.classList.add("task-row", "task-new");

    const tdLeft = tr.createEl("td");
    tdLeft.classList.add("task-cell");
    tdLeft.style.padding = "6px 8px";
    tdLeft.style.verticalAlign = "top";
    tdLeft.style.width = "100%";

    const leftWrap = tdLeft.createDiv();
    leftWrap.addClass("row-wrap");

    // Visible PLUS icon (replaces the "bullet" affordance)
    const plus = leftWrap.createSpan({ text: "+" });
    plus.addClass("plus");
    plus.title = "Add new task";

    // Hidden checkbox spacer (to align the text with normal rows)
    const ghostCb = leftWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    ghostCb.style.visibility = "hidden";
    ghostCb.style.flex = "0 0 auto";

    const textWrap = leftWrap.createDiv();
    textWrap.style.flex = "1 1 auto";
    textWrap.style.minWidth = "0";

    const input = textWrap.createDiv({ text: "New" });
    input.addClass("task-edit", "placeholder");
    input.contentEditable = "true";
    input.spellcheck = false;
    input.style.whiteSpace = "pre-wrap";
    input.style.outline = "none";

    const tdRight = tr.createEl("td");
    tdRight.classList.add("task-cell");
    tdRight.style.padding = "6px 8px";
    tdRight.style.textAlign = "right";
    tdRight.style.whiteSpace = "nowrap";
    tdRight.style.verticalAlign = "top";
    // No open/delete buttons in placeholder

    // hide when group/file collapsed
    if (this.collapsedGroups.has(groupKey) || this.collapsedFiles.has(filePath)) {
      tr.style.display = "none";
    }

    // Placeholder life-cycle: clear on focus/click; restore on blur if empty
    const clearPlaceholder = () => {
      if (input.classList.contains("placeholder")) {
        input.empty();
        input.classList.remove("placeholder");
      }
    };
    input.addEventListener("focus", clearPlaceholder);
    input.addEventListener("click", clearPlaceholder);

    input.addEventListener("blur", () => {
      const txt = (input.textContent ?? "").trim();
      if (!txt) {
        input.setText("New");
        input.classList.add("placeholder");
      }
    });

    // create on commit
    const commitCreate = async () => {
      const text = (input.textContent ?? "").trim();
      if (!text || input.classList.contains("placeholder")) return;
      await this.createNewTaskAtEnd(filePath, text);
    };

    // Enter commits
    input.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await commitCreate();
      }
    });

    // first real typing commits immediately, then we keep focus on the new item
    input.addEventListener("input", async () => {
      if (!input.classList.contains("placeholder")) {
        await commitCreate();
      }
    });

    // Drag target: highlight ABOVE placeholder (so drop inserts before it)
    tr.addEventListener("dragover", (e) => {
      if (!this.draggingId) return;
      e.preventDefault();
      this.clearHoverStyles();
      tr.classList.add("hover-top");
      this.hoverTarget = null; // custom drop handler
    });
    tr.addEventListener("dragleave", () => {
      tr.classList.remove("hover-top");
    });
    tr.addEventListener("drop", async (e) => {
      e.preventDefault();
      tr.classList.remove("hover-top");
      if (!this.draggingId) return;
      const source = this.rowById.get(this.draggingId);
      this.draggingId = null;
      if (!source) return;
      const st = this.scroller?.scrollTop ?? 0;
      try {
        await this.withSquelch(async () => {
          await this.moveSubtreeToFileEnd(source, filePath, 1);
        });
        await this.scanTasks();
        if (this.scroller) this.scroller.scrollTop = st;
        new Notice("Item moved.");
      } catch (err) {
        console.error(err);
        new Notice("Move failed.");
      }
    });

    this.newRowByFile.set(filePath, tr);
  }

  private async createNewTaskAtEnd(filePath: string, text: string) {
    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    if (!file) return;
    try {
      this.setSaving(true);
      await this.withSquelch(async () => {
        const content = await this.app.vault.read(file);
        // Determine true insert index (before a trailing empty line, if any)
        const lines = content.length ? content.split("\n") : [];
        let insertAt = lines.length;
        if (insertAt > 0 && lines[insertAt - 1] === "") insertAt = insertAt - 1;

        const newLine = `- [ ] ${text}`;
        lines.splice(insertAt, 0, newLine);
        const newContent = lines.join("\n");
        await this.app.vault.modify(file, newContent.endsWith("\n") ? newContent : newContent + "\n");
        // focus the new item (preview -> edit) after rescan
        this.pendingFocusId = `${filePath}::${insertAt}`;
      });
      await this.scanTasks();
    } finally {
      this.setSaving(false);
    }
  }

  private async moveSubtreeToFileEnd(source: RowRef, destFilePath: string, newDepth: number) {
    const srcFile = this.app.vault.getAbstractFileByPath(source.filePath) as TFile;
    const destFile = this.app.vault.getAbstractFileByPath(destFilePath) as TFile;

    // read src
    let srcContent = await this.app.vault.read(srcFile);
    let srcLines = srcContent.split("\n");

    const taskRegex = /^\s*[-*]\s\[[ xX]\]\s.+/;

    // find source block
    const start = source.lineIndex;
    const srcDepth = getIndentDepth(srcLines[start] ?? source.originalLine);
    let end = start;
    for (let i = start + 1; i < srcLines.length; i++) {
      const ln = srcLines[i];
      if (!taskRegex.test(ln)) break;
      const d = getIndentDepth(ln);
      if (d <= srcDepth) break;
      end = i;
    }
    const block = srcLines.slice(start, end + 1);

    // adjust depths
    const depthDelta = newDepth - srcDepth;
    const adjusted = block.map((ln) => {
      if (!taskRegex.test(ln)) return ln;
      const d = getIndentDepth(ln);
      const nd = Math.max(1, d + depthDelta);
      return this.lineWithDepth(ln, nd);
    });

    // remove from src
    await this.app.vault.modify(
      srcFile,
      [...srcLines.slice(0, start), ...srcLines.slice(end + 1)].join("\n")
    );

    // append just before trailing empty line (if any)
    const destContent = await this.app.vault.read(destFile);
    const dLines = destContent.split("\n");
    let insertAt = dLines.length;
    if (insertAt > 0 && dLines[insertAt - 1] === "") insertAt = insertAt - 1;
    dLines.splice(insertAt, 0, ...adjusted);
    const out = dLines.join("\n");
    await this.app.vault.modify(destFile, out.endsWith("\n") ? out : out + "\n");
  }
}

export {};