import { TFile, Component, App } from "obsidian";

export type TaskEntry = {
	file: TFile;
	lineIndex: number;
	originalLine: string;
	depth: number;
	rootKey: string;
	rootToken: string;
	id: string;
	parentId?: string;
};

export type RowRef = {
	id: string;
	parentId?: string;
	depth: number;
	hasChildren: boolean;
	filePath: string;
	lineIndex: number;
	tr: HTMLTableRowElement;
	numEl: HTMLSpanElement;
	checkbox: HTMLInputElement;
	textCell: HTMLDivElement;
	previewCell: HTMLDivElement;
	mdComp: Component;
	originalLine: string;
	rootToken: string;
	groupKey: string;
	renderTimer?: number;
	leftWrap: HTMLDivElement;
};

export type FileBucket = { filePath: string; fileName: string; items: TaskEntry[] };
export type GroupBucket = { key: string; name: string; files: FileBucket[] };

export type CompiledRule = { name: string; re: RegExp };

export type UIRefs = {
	container: HTMLElement;
	statusBar: HTMLDivElement;
	statusIcon: HTMLSpanElement;
	scroller: HTMLDivElement;
	table: HTMLTableElement;
	tbody: HTMLTableSectionElement;
};

export type ScanResult = {
	groups: GroupBucket[];
	tasksByFile: Map<string, TaskEntry[]>;
	childrenById: Map<string, string[]>;
	hasGroups: boolean;
};

export type AppLike = App;
