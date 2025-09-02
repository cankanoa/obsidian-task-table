import { Store } from "../state/store";
import { RowRef } from "../types";
import { TASK_RX, getIndentDepth, lineWithDepth } from "../utils/text";

export async function moveAsTopChild(store: Store, source: RowRef, parent: RowRef) {
	const newDepth = parent.depth + 1;
	const targetFilePath = parent.filePath;
	const insertAt = parent.lineIndex + 1;
	await relocateSubtree(store, source, targetFilePath, insertAt, newDepth);
}

export async function moveBetweenWithMaxNeighborDepth(store: Store, source: RowRef, target: RowRef, after: boolean) {
	const destFilePath = target.filePath;
	const aboveRow = after ? target : getPreviousRowInFile(store, target);
	const belowRow = after ? getNextRowInFile(store, target) : target;
	const newDepth = Math.max(aboveRow ? aboveRow.depth : 1, belowRow ? belowRow.depth : 1, 1);
	const insertAt = after ? target.lineIndex + 1 : target.lineIndex;
	await relocateSubtree(store, source, destFilePath, insertAt, newDepth);
}

export async function moveSubtreeToFileEnd(store: Store, source: RowRef, destFilePath: string, newDepth: number) {
	const srcFile = store.app.vault.getAbstractFileByPath(source.filePath) as any;
	const destFile = store.app.vault.getAbstractFileByPath(destFilePath) as any;

	const srcContent = await store.app.vault.read(srcFile);
	const srcLines = srcContent.split("\n");

	const start = source.lineIndex;
	const srcDepth = getIndentDepth(srcLines[start] ?? source.originalLine);
	let end = start;
	for (let i = start + 1; i < srcLines.length; i++) {
		const ln = srcLines[i]; if (!TASK_RX.test(ln)) break;
		const d = getIndentDepth(ln); if (d <= srcDepth) break; end = i;
	}
	const block = srcLines.slice(start, end + 1);
	const depthDelta = newDepth - srcDepth;
	const adjusted = block.map(ln => {
		if (!TASK_RX.test(ln)) return ln;
		const d = getIndentDepth(ln);
		const nd = Math.max(1, d + depthDelta);
		return lineWithDepth(ln, nd);
	});

	await store.app.vault.modify(srcFile, [...srcLines.slice(0, start), ...srcLines.slice(end + 1)].join("\n"));

	const destContent = await store.app.vault.read(destFile);
	const dLines = destContent.split("\n");
	let insertAt = dLines.length; if (insertAt > 0 && dLines[insertAt - 1] === "") insertAt--;
	dLines.splice(insertAt, 0, ...adjusted);
	const out = dLines.join("\n");
	await store.app.vault.modify(destFile, out.endsWith("\n") ? out : out + "\n");
}

export async function deleteSubtree(store: Store, row: RowRef) {
	const srcFile = store.app.vault.getAbstractFileByPath(row.filePath) as any;
	if (!srcFile) return;

	const content = await store.app.vault.read(srcFile);
	const lines = content.split("\n");
	const start = row.lineIndex;
	if (start < 0 || start >= lines.length) return;

	const base = lines[start] ?? row.originalLine;
	if (!TASK_RX.test(base)) return;

	const srcDepth = getIndentDepth(base);
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const ln = lines[i]; if (!TASK_RX.test(ln)) break;
		const d = getIndentDepth(ln); if (d <= srcDepth) break; end = i;
	}

	const blockLen = end - start + 1;
	lines.splice(start, blockLen);
	await store.app.vault.modify(srcFile, lines.join("\n"));
}

async function relocateSubtree(store: Store, source: RowRef, destFilePath: string, insertAtIn: number, newDepth: number) {
	const srcFile = store.app.vault.getAbstractFileByPath(source.filePath) as any;
	const destFile = store.app.vault.getAbstractFileByPath(destFilePath) as any;

	let srcContent = await store.app.vault.read(srcFile);
	let srcLines = srcContent.split("\n");

	const start = source.lineIndex;
	const srcDepth = getIndentDepth(srcLines[start] ?? source.originalLine);
	let end = start;
	for (let i = start + 1; i < srcLines.length; i++) {
		const ln = srcLines[i]; if (!TASK_RX.test(ln)) break;
		const d = getIndentDepth(ln); if (d <= srcDepth) break; end = i;
	}
	const blockLen = end - start + 1;

	const adjustedBlock = srcLines.slice(start, end + 1).map((ln) => {
		if (!TASK_RX.test(ln)) return ln;
		const d = getIndentDepth(ln);
		const nd = Math.max(1, d + (newDepth - srcDepth));
		return lineWithDepth(ln, nd);
	});

	await store.withSquelch(async () => {
		srcLines.splice(start, blockLen);
		await store.app.vault.modify(srcFile, srcLines.join("\n"));
	});

	let insertAt = insertAtIn;
	let destLines: string[];
	if (srcFile.path === destFile.path) {
		destLines = srcLines;
		if (start < insertAt) insertAt -= blockLen;
	} else {
		const destContent = await store.app.vault.read(destFile);
		destLines = destContent.split("\n");
	}

	insertAt = Math.max(0, Math.min(destLines.length, insertAt));
	await store.withSquelch(async () => {
		destLines.splice(insertAt, 0, ...adjustedBlock);
		await store.app.vault.modify(destFile, destLines.join("\n"));
	});
}

function getPreviousRowInFile(store: Store, ref: RowRef): RowRef | null {
	const idx = store.rowRefs.findIndex(r => r.id === ref.id);
	for (let i = idx - 1; i >= 0; i--) if (store.rowRefs[i].filePath === ref.filePath) return store.rowRefs[i];
	return null;
}
function getNextRowInFile(store: Store, ref: RowRef): RowRef | null {
	const idx = store.rowRefs.findIndex(r => r.id === ref.id);
	for (let i = idx + 1; i < store.rowRefs.length; i++) if (store.rowRefs[i].filePath === ref.filePath) return store.rowRefs[i];
	return null;
}
