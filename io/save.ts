import { Store } from "../state/store";
import { buildLine } from "../utils/text";

const autosaveDebounced = new Map<Store, number>();

export function scheduleAutosave(store: Store) {
	const prev = autosaveDebounced.get(store);
	if (prev) window.clearTimeout(prev);
	const t = window.setTimeout(() => saveEdits(store), 600);
	autosaveDebounced.set(store, t);
}

export async function saveEdits(store: Store) {
	if (!store.rowRefs.length || !store.tasksByFile.size) return;
	const versionAtStart = store.editsVersion;
	const byFile = new Map<string, { lineIndex: number; newLine: string }[]>();

	for (const ref of store.rowRefs) {
		const text = (ref.textCell.textContent ?? "").trim();
		const newLine = buildLine(ref.originalLine, ref.checkbox.checked, text);
		if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
		byFile.get(ref.filePath)!.push({ lineIndex: ref.lineIndex, newLine });
	}

	try {
		store.setSaving(true);
		await store.withSquelch(async () => {
			for (const [path, edits] of byFile.entries()) {
				edits.sort((a, b) => a.lineIndex - b.lineIndex);
				const file = store.tasksByFile.get(path)?.[0]?.file;
				if (!file) continue;
				const content = await store.app.vault.read(file);
				const lines = content.split("\n");
				for (const e of edits) {
					if (e.lineIndex >= 0 && e.lineIndex < lines.length) lines[e.lineIndex] = e.newLine;
				}
				await store.app.vault.modify(file, lines.join("\n"));
			}
		});
		for (const ref of store.rowRefs) {
			const text = (ref.textCell.textContent ?? "").trim();
			ref.originalLine = buildLine(ref.originalLine, ref.checkbox.checked, text);
		}
		store.markCleanIf(versionAtStart);
	} finally {
		store.setSaving(false);
	}
}

export async function saveRowImmediate(store: Store, args: {
	filePath: string; lineIndex: number; originalLine: string; checked: boolean; text: string;
}) {
	const { filePath, lineIndex, originalLine, checked, text } = args;
	const file = store.app.vault.getAbstractFileByPath(filePath);
	if (!file) return;
	try {
		store.setSaving(true);
		await store.withSquelch(async () => {
			const content = await store.app.vault.read(file as any);
			const lines = content.split("\n");
			if (lineIndex < 0 || lineIndex >= lines.length) return;
			const newLine = buildLine(originalLine, checked, (text ?? "").trim());
			if (lines[lineIndex] === newLine) return;
			lines[lineIndex] = newLine;
			await store.app.vault.modify(file as any, lines.join("\n"));
		});
	} finally {
		store.setSaving(false);
	}
}

export async function createNewTaskAtEnd(store: Store, filePath: string, text: string) {
	const file = store.app.vault.getAbstractFileByPath(filePath);
	if (!file) return;
	try {
		store.setSaving(true);
		await store.withSquelch(async () => {
			const content = await store.app.vault.read(file as any);
			const lines = content.length ? content.split("\n") : [];
			let insertAt = lines.length;
			if (insertAt > 0 && lines[insertAt - 1] === "") insertAt = insertAt - 1;
			const newLine = `- [ ] ${text}`;
			lines.splice(insertAt, 0, newLine);
			const out = lines.join("\n");
			await store.app.vault.modify(file as any, out.endsWith("\n") ? out : out + "\n");
			store.pendingFocusId = `${filePath}::${insertAt}`;
		});
	} finally {
		store.setSaving(false);
	}
}
