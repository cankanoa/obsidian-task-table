import { AppLike, UIRefs, RowRef, ScanResult } from "../types";
import { MyPluginSettings } from "../main";
import { updateStatusIcon } from "../ui/render"

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
	tasksByFile = new Map<string, any>();
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
	hueOrder = 0;
	readonly GOLDEN_ANGLE = 137.508;
	readonly huePhase = Math.random() * 360;
	SAT = 78; L_BASE = 42; L_STEP = 20; L_MAX = 90;

	pendingFocusId: string | null = null;

	constructor(app: AppLike, settings: MyPluginSettings, ui: UIRefs) {
		this.app = app;
		this.settings = settings;
		this.ui = ui;
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
	}

	resetTableMaps() {
		this.rowRefs = [];
		this.rowById.clear();
		this.groupHeaderRow.clear();
		this.fileHeaderRow.clear();
		this.newRowByFile.clear();
	}
}
