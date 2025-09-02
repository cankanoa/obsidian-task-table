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
export async function scanTasks(app: App, compiled: CompiledRule[]): Promise<ScanResult> {
	const tasksByFile = new Map<string, TaskEntry[]>();
	const childrenById = new Map<string, string[]>();

	if (!compiled.length) {
		return { groups: [], tasksByFile, childrenById, hasGroups: false };
	}

	const hasGroups = compiled.some((c) => (c.name ?? "").trim().length > 0);
	const allMdFiles: TFile[] = app.vault.getMarkdownFiles();

	// For grouped mode: Map<groupName, Map<filePath, FileBucket>>
	const groupsMap = new Map<string, Map<string, FileBucket>>();
	// For single-layer mode: Map<filePath, FileBucket>
	const flatFiles = new Map<string, FileBucket>();

	for (const file of allMdFiles) {
		const path = file.path;

		// Determine which rules match this file
		const matched = compiled.filter((c) => c.re.test(path));
		if (!matched.length) continue;

		// Parse tasks for this file once
		const content = await app.vault.read(file);
		const lines = content.split("\n");

		const rawEntries: TaskEntry[] = [];
		let currentRootKey = "";
		let currentRootToken = "";
		let lastRootKey = "";
		let lastRootToken = "";

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!TASK_RX.test(line)) continue;

			const depth = getIndentDepth(line);
			const id = `${file.path}::${i}`;

			if (depth === 1) {
				currentRootKey = id;
				currentRootToken = rootTokenFromLine(line);
				lastRootKey = currentRootKey;
				lastRootToken = currentRootToken;
			} else {
				if (!currentRootKey) currentRootKey = lastRootKey || `${file.path}::first`;
				if (!currentRootToken) currentRootToken = lastRootToken || "untitled-root";
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

		// Parent links via stack
		const stack: TaskEntry[] = [];
		for (const e of rawEntries) {
			while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
			e.parentId = stack.length ? stack[stack.length - 1].id : undefined;
			stack.push(e);
		}

		// Children index
		for (const e of rawEntries) {
			if (!e.parentId) continue;
			if (!childrenById.has(e.parentId)) childrenById.set(e.parentId, []);
			childrenById.get(e.parentId)!.push(e.id);
		}

		if (rawEntries.length) tasksByFile.set(file.path, rawEntries);

		// Fill output structures
		const rawName = path.split("/").pop() ?? path;
		const fileName = rawName.replace(/\.md$/i, "");

		if (!hasGroups) {
			// Single-layer: every matched file shows once total
			if (!flatFiles.has(path)) {
				flatFiles.set(path, { filePath: path, fileName, items: rawEntries });
			}
		} else {
			// Grouped: add once per matched non-empty group name
			const groupNames = Array.from(
				new Set(
					matched
						.map((m) => (m.name ?? "").trim())
						.filter((n) => n.length > 0)
				)
			);

			for (const gName of groupNames) {
				if (!groupsMap.has(gName)) groupsMap.set(gName, new Map<string, FileBucket>());
				const filesMap = groupsMap.get(gName)!;
				// Important: within a group, add this file only once
				if (!filesMap.has(path)) {
					filesMap.set(path, { filePath: path, fileName, items: rawEntries });
				}
			}
		}
	}

	let groups: GroupBucket[] = [];

	if (!hasGroups) {
		// Single-layer: produce a single pseudo-group that the UI will render without a group header
		const filesArr = Array.from(flatFiles.values()).sort((a, b) => a.fileName.localeCompare(b.fileName));
		groups = [{ key: "__ALL__", name: "", files: filesArr }];
	} else {
		// Grouped: deterministic order by group name, then file name
		const groupNames = Array.from(groupsMap.keys()).sort((a, b) => a.localeCompare(b));
		for (const gName of groupNames) {
			const filesArr = Array.from(groupsMap.get(gName)!.values()).sort((a, b) =>
				a.fileName.localeCompare(b.fileName)
			);
			groups.push({ key: gName, name: gName, files: filesArr });
		}
	}

	return { groups, tasksByFile, childrenById, hasGroups };
}
