import { AppLike, UIRefs, RowRef, ScanResult, TaskEntry } from "../types";
import { MyPluginSettings } from "../main";
import { updateStatusIcon } from "../ui/render"
import type { TFile } from "obsidian";

type Providers = {
	getIndexedFiles: () => TFile[];
};

export class Store {
	app: AppLike;
	settings: MyPluginSettings;
	ui: UIRefs;

	// status
	savingDepth = 0;
	dirty = false;
	editsVersion = 0;
	squelchScanDepth = 0;
	silentStylePass = false;

	rowRefs: RowRef[] = [];
	tasksByFile = new Map<string, TaskEntry[]>();
	childrenById = new Map<string, string[]>();
	rowById = new Map<string, RowRef>();
	collapsed = new Set<string>();
	collapsedGroups = new Set<string>();
	collapsedFiles = new Set<string>();
	groupHeaderRow = new Map<string, HTMLTableRowElement>();
	fileHeaderRow = new Map<string, HTMLTableRowElement>();
	newRowByFile = new Map<string, HTMLTableRowElement>();

	draggingId: string | null = null;
	hoverTarget: { id: string; mode: "on" | "before" | "after" } | null = null;

	hueByRootToken = new Map<string, number>();
	readonly GOLDEN_ANGLE = 137.508;
	readonly huePhase = Math.random() * 360;
	SAT = 78; L_BASE = 42; L_STEP = 20; L_MAX = 90;

	pendingFocusId: string | null = null;

	providers: Providers;

	constructor(app: AppLike, settings: MyPluginSettings, ui: UIRefs, providers: Providers) {
		this.app = app;
		this.settings = settings;
		this.ui = ui;
		this.providers = providers;
	}

	setSaving(on: boolean) {
		this.savingDepth = Math.max(0, this.savingDepth + (on ? 1 : -1));
		updateStatusIcon(this);
	}
	markDirty() {
		this.dirty = true;
		this.editsVersion++;
		updateStatusIcon(this);
	}
	markCleanIf(versionAtStart: number) {
		if (this.editsVersion === versionAtStart) {
			this.dirty = false;
			updateStatusIcon(this);
		}
	}
	async withSquelch<T>(fn: () => Promise<T>): Promise<T> {
		this.squelchScanDepth++;
		try { return await fn(); }
		finally { this.squelchScanDepth = Math.max(0, this.squelchScanDepth - 1); }
	}

	applyScan(result: ScanResult) {
		this.tasksByFile = result.tasksByFile;
		this.childrenById = result.childrenById;

		this.hueByRootToken.clear();

		const tokens = new Set<string>();
		for (const tasks of result.tasksByFile.values()) {
			for (const t of tasks) tokens.add(t.rootToken);
		}

		const ordered = Array.from(tokens).sort((a, b) => a.localeCompare(b));
		for (let i = 0; i < ordered.length; i++) {
			const hue = (this.huePhase + i * this.GOLDEN_ANGLE) % 360;
			this.hueByRootToken.set(ordered[i], hue);
		}
	}

	resetTableMaps() {
		this.rowRefs = [];
		this.rowById.clear();
		this.groupHeaderRow.clear();
		this.fileHeaderRow.clear();
		this.newRowByFile.clear();
	}
}
