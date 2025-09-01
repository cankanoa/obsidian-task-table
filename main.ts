import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { TaskTableView } from "./views/TaskTableView";

export const TASK_TABLE_VIEW_TYPE = "task-table-view";

/** A single matching rule row. */
export interface TaskTableRule {
  /** Top-level subcategory label to group files under. */
  name: string;
  /** JavaScript RegExp (no slashes) matched against full file path. */
  re: string;
}

export interface MyPluginSettings {
  /** List of path-matching rules. Files matching a rule’s `re` show under its `name`. */
  regexRules: TaskTableRule[];
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  regexRules: [],
};

export default class MyPlugin extends Plugin {
  settings: MyPluginSettings = DEFAULT_SETTINGS;
  private settingTab!: SampleSettingTab;

  async onload() {
    await this.loadSettings();

    this.registerView(
      TASK_TABLE_VIEW_TYPE,
      (leaf) => new TaskTableView(leaf, this) // pass plugin to view
    );

    // Ribbon icon to open the Task Table view
    const ribbonIconEl = this.addRibbonIcon("dice", "Open Task Table", async () => {
      await this.activateView();
    });
    ribbonIconEl.addClass("my-plugin-ribbon-class");

    // Status bar (kept from sample)
    const statusBarItemEl = this.addStatusBarItem();
    statusBarItemEl.setText("Status Bar Text");

    // Sample commands (kept from sample)
    this.addCommand({
      id: "open-sample-modal-simple",
      name: "Open sample modal (simple)",
      callback: () => new SampleModal(this.app).open(),
    });

    this.addCommand({
      id: "sample-editor-command",
      name: "Sample editor command",
      editorCallback: (editor: Editor) => {
        console.log(editor.getSelection());
        editor.replaceSelection("Sample Editor Command");
      },
    });

    this.addCommand({
      id: "open-sample-modal-complex",
      name: "Open sample modal (complex)",
      checkCallback: (checking: boolean) => {
        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          if (!checking) new SampleModal(this.app).open();
          return true;
        }
      },
    });

    // Settings tab
    this.settingTab = new SampleSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Example global DOM event, interval (kept from sample)
    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      console.log("click", evt);
    });

    this.registerInterval(window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000));
  }

  onunload() {}

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Called by the view when the gear icon is clicked. */
  openSettings() {
    const anyApp = this.app as any;
    anyApp?.setting?.open?.();
    // Prefer selecting our tab if available:
    if (this.settingTab && anyApp?.setting?.openTab) {
      anyApp.setting.openTab(this.settingTab);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    const existingLeaf = workspace.getLeavesOfType(TASK_TABLE_VIEW_TYPE)[0];
    if (existingLeaf) {
      workspace.revealLeaf(existingLeaf);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: TASK_TABLE_VIEW_TYPE, active: true });
  }
}

class SampleModal extends Modal {
  onOpen() {
    this.contentEl.setText("Woah!");
  }
  onClose() {
    this.contentEl.empty();
  }
}

class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;
  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---- Section: Regular expressions matching files ----
    containerEl.createEl("h2", { text: "Regular expressions matching files" });

    // Existing rows (locked as text with remove ✕)
    const listWrap = containerEl.createDiv();
    listWrap.style.display = "flex";
    listWrap.style.flexDirection = "column";
    listWrap.style.gap = "6px";

    const renderRows = () => {
      listWrap.empty();
      if (!this.plugin.settings.regexRules.length) {
        const empty = listWrap.createDiv({ text: "No rules yet." });
        empty.style.opacity = "0.7";
      }
      this.plugin.settings.regexRules.forEach((rule, idx) => {
        const row = listWrap.createDiv();
        row.addClass("tasktable-rule-row");
        row.style.display = "grid";
        row.style.gridTemplateColumns = "minmax(140px, 1fr) minmax(260px, 2fr) auto";
        row.style.alignItems = "center";
        row.style.gap = "8px";

        // Locked "Name"
        const nameText = row.createDiv({ text: rule.name });
        nameText.style.fontWeight = "600";
        nameText.style.whiteSpace = "nowrap";
        nameText.style.overflow = "hidden";
        nameText.style.textOverflow = "ellipsis";

        // Locked "re"
        const reText = row.createDiv({ text: rule.re });
        reText.style.fontFamily = "var(--font-monospace)";
        reText.style.opacity = "0.9";
        reText.style.overflow = "hidden";
        reText.style.textOverflow = "ellipsis";

        // Remove button (✕)
        const removeSlot = row.createDiv();
        new Setting(removeSlot)
          .addExtraButton((btn) =>
            btn
              .setIcon("x")
              .setTooltip("Remove")
              .onClick(async () => {
                this.plugin.settings.regexRules.splice(idx, 1);
                await this.plugin.saveSettings();
                renderRows();
                renderAddRow();
              })
          )
          .setClass("tasktable-rule-remove");
      });
    };

    // Add-row (editable Name + re + +button) always rendered beneath the list
    const addWrap = containerEl.createDiv();
    const renderAddRow = () => {
      addWrap.empty();
      const grid = addWrap.createDiv();
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "minmax(140px, 1fr) minmax(260px, 2fr) auto";
      grid.style.alignItems = "center";
      grid.style.gap = "8px";

      let pendingName = "";
      let pendingRe = "";

      // Name
      const nameSlot = grid.createDiv();
      new Setting(nameSlot)
        .setName("Name")
        .setDesc("Top-level subcategory label")
        .addText((t) =>
          t
            .setPlaceholder("e.g., Projects")
            .onChange((v) => (pendingName = v.trim()))
        );

      // re
      const reSlot = grid.createDiv();
      new Setting(reSlot)
        .setName("re")
        .setDesc("Match file paths (JS RegExp, no slashes)")
        .addText((t) =>
          t
            .setPlaceholder(String.raw`e.g., ^Projects\/.+\.md$`)
            .onChange((v) => (pendingRe = v.trim()))
        );

      // +
      const addSlot = grid.createDiv();
      new Setting(addSlot).addExtraButton((btn) =>
        btn
          .setIcon("plus")
          .setTooltip("Add rule")
          .onClick(async () => {
            if (!pendingName || !pendingRe) {
              new Notice("Please provide both Name and re.");
              return;
            }
            // Validate regex
            try {
              // eslint-disable-next-line no-new
              new RegExp(pendingRe);
            } catch (e) {
              new Notice("Invalid regular expression.");
              return;
            }
            this.plugin.settings.regexRules.push({ name: pendingName, re: pendingRe });
            await this.plugin.saveSettings();
            renderRows();
            renderAddRow();
          })
      );
    };

    renderRows();
    renderAddRow();

    // (Optional) Other settings can remain or be removed
  }
}