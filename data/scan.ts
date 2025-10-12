import { App, TFile } from "obsidian";
import { CompiledRule, FileBucket, GroupBucket, ScanResult, TaskEntry } from "../types";
import { rootTokenFromLine, getIndentDepth, TASK_RX } from "../utils/text";

export const compileRules = (rules: { name: string; re: string }[]) =>
	rules
		.map((r) => {
			try {
				return { name: r.name ?? "", re: new RegExp(r.re) } as CompiledRule;
			} catch {
				return null;
			}
		})
		.filter(Boolean) as CompiledRule[];

/**
 * Rules:
 * - If ALL rule names are empty => single-layer UI (file headers only).
 * - Otherwise => group by rule.name; a file may appear under multiple groups if matched by different rules.
 *   (Within the same group, the file appears only once even if multiple rules with the same group name match.)
 */

// Accepts a pre-indexed list of files; does not discover new files.
export async function scanTasks(
	app: App,
	compiled: CompiledRule[],
	files: TFile[]
): Promise<ScanResult> {
	const tasksByFile = new Map<string, TaskEntry[]>();
	const childrenById = new Map<string, string[]>();
	if (!compiled.length || files.length === 0)
		return { groups: [], tasksByFile, childrenById, hasGroups: false };

	const hasGroups = compiled.some((c) => (c.name ?? "").trim().length > 0);
	const groupsMap = new Map<string, Map<string, FileBucket>>();
	const flatFiles = new Map<string, FileBucket>();

	for (const file of files) {
		const path = file.path;
		const matched = getMatchedRules(path, compiled);
		if (!matched.length) continue;

		// Cached parse
		const { entries: rawEntries, childrenById: localChildren } = await getCachedFileParse(app, file);

		// Merge into global maps
		if (rawEntries.length) tasksByFile.set(path, rawEntries);
		for (const [pid, kids] of localChildren) {
			if (!childrenById.has(pid)) childrenById.set(pid, []);
			childrenById.get(pid)!.push(...kids);
		}

		// Grouping
		const fileName = extractFileName(path);
		addFileToGroups(path, fileName, rawEntries, matched, hasGroups, flatFiles, groupsMap);
	}

	const groups = buildGroupBuckets(hasGroups, flatFiles, groupsMap);
	return { groups, tasksByFile, childrenById, hasGroups };
}

async function getCachedFileParse(app: App, file: TFile): Promise<{ entries: TaskEntry[]; childrenById: Map<string, string[]> }> {
	const path = file.path;
	const mtime = file.stat?.mtime ?? 0;
	const cached = TASK_PARSE_CACHE.get(path);

	if (cached && cached.mtime === mtime) {
		return { entries: cached.entries, childrenById: cached.childrenById };
	}

	const lines = (await app.vault.read(file)).split("\n");
	const entries: TaskEntry[] = [];
	const childrenById = new Map<string, string[]>();
	let currentRootKey = "", currentRootToken = "", lastRootKey = "", lastRootToken = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!TASK_RX.test(line)) continue;
		const depth = getIndentDepth(line);
		const id = `${path}::${i}`;

		if (depth === 1) {
			currentRootKey = id;
			currentRootToken = rootTokenFromLine(line);
			lastRootKey = currentRootKey;
			lastRootToken = currentRootToken;
		} else {
			if (!currentRootKey) currentRootKey = lastRootKey || `${path}::first`;
			if (!currentRootToken) currentRootToken = lastRootToken || "untitled-root";
		}

		entries.push({
			file, lineIndex: i, originalLine: line, depth,
			rootKey: currentRootKey, rootToken: currentRootToken, id,
		});
	}

	const stack: TaskEntry[] = [];
	for (const e of entries) {
		while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
		e.parentId = stack.length ? stack[stack.length - 1].id : undefined;
		stack.push(e);
	}

	for (const e of entries) {
		if (!e.parentId) continue;
		if (!childrenById.has(e.parentId)) childrenById.set(e.parentId, []);
		childrenById.get(e.parentId)!.push(e.id);
	}

	TASK_PARSE_CACHE.set(path, { mtime, entries, childrenById });
	return { entries, childrenById };
}

/** Clear cached parse for one file (optional external use). */
export function invalidateCachedFile(path: string) {
	TASK_PARSE_CACHE.delete(path);
}


function getMatchedRules(path: string, compiled: CompiledRule[]): CompiledRule[] {
	return compiled.filter((c) => c.re.test(path));
}

function extractFileName(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}



type CachedParse = {
	mtime: number;
	entries: TaskEntry[];
	// children index for this file only
	childrenById: Map<string, string[]>;
};
const TASK_PARSE_CACHE = new Map<string, CachedParse>();

/** Builds parent/child relationships in a list of TaskEntry objects. */
function buildParentChildLinks(entries: TaskEntry[]): Map<string, string[]> {
	const childrenById = new Map<string, string[]>();
	const stack: TaskEntry[] = [];

	for (const e of entries) {
		while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
		e.parentId = stack.length ? stack[stack.length - 1].id : undefined;
		stack.push(e);
	}

	for (const e of entries) {
		if (!e.parentId) continue;
		if (!childrenById.has(e.parentId)) childrenById.set(e.parentId, []);
		childrenById.get(e.parentId)!.push(e.id);
	}

	return childrenById;
}

/** Groups a parsed file into either flat or named group buckets. */
function addFileToGroups(
	path: string,
	fileName: string,
	rawEntries: TaskEntry[],
	matched: CompiledRule[],
	hasGroups: boolean,
	flatFiles: Map<string, FileBucket>,
	groupsMap: Map<string, Map<string, FileBucket>>
) {
	if (!rawEntries.length) return;

	if (!hasGroups) {
		if (!flatFiles.has(path))
			flatFiles.set(path, { filePath: path, fileName, items: rawEntries });
	} else {
		const groupNames = Array.from(
			new Set(matched.map((m) => (m.name ?? "").trim()).filter(Boolean))
		);
		for (const gName of groupNames) {
			if (!groupsMap.has(gName)) groupsMap.set(gName, new Map<string, FileBucket>());
			const filesMap = groupsMap.get(gName)!;
			if (!filesMap.has(path))
				filesMap.set(path, { filePath: path, fileName, items: rawEntries });
		}
	}
}

/** Converts file/group maps into final GroupBucket[] for output. */
function buildGroupBuckets(
	hasGroups: boolean,
	flatFiles: Map<string, FileBucket>,
	groupsMap: Map<string, Map<string, FileBucket>>
): GroupBucket[] {
	if (!hasGroups) {
		const filesArr = Array.from(flatFiles.values()).sort((a, b) =>
			a.fileName.localeCompare(b.fileName)
		);
		return [{ key: "__ALL__", name: "", files: filesArr }];
	}

	const names = Array.from(groupsMap.keys()).sort((a, b) => a.localeCompare(b));
	const groups: GroupBucket[] = [];
	for (const gName of names) {
		const filesArr = Array.from(groupsMap.get(gName)!.values()).sort((a, b) =>
			a.fileName.localeCompare(b.fileName)
		);
		groups.push({ key: gName, name: gName, files: filesArr });
	}
	return groups;
}
