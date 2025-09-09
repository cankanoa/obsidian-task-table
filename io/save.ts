import { Store } from "../state/store";
import { buildLine } from "../utils/text";
import { mountTable } from "../ui/render";        // <-- path: wherever your mountTable lives

// WeakMap so the Store can be GC’d when the view closes
const autosaveDebounced: WeakMap<Store, number> = new WeakMap();

export function scheduleAutosave(store: Store) {
	const prev = autosaveDebounced.get(store);
	if (prev) window.clearTimeout(prev);
	const t = window.setTimeout(() => saveEdits(store), 600);
	autosaveDebounced.set(store, t);
}

// allow view to cancel onClose
export function clearAutosave(store: Store | null) {
	if (!store) return;
	const t = autosaveDebounced.get(store);
	if (t) window.clearTimeout(t);
	autosaveDebounced.delete(store);
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
					if (e.lineIndex >= 0 && e.lineIndex < lines.length) {
						lines[e.lineIndex] = e.newLine;
					}
				}
				await store.app.vault.modify(file, lines.join("\n"));
			}
		});
		for (const ref of store.rowRefs) {
			const text = (ref.textCell.textContent ?? "").trim();
			ref.originalLine = buildLine(ref.originalLine, ref.checkbox.checked, text);

			if ((ref.previewCell as any)?.isShown?.()) {
				await renderRowMarkdown(store, ref);
			}
		}
		store.markCleanIf(versionAtStart);
	} catch (e) {
		console.error(e);
	} finally {
		store.setSaving(false);
	}
}

// === The two missing functions used by ui/render.ts ===

export async function saveRowImmediate(store: Store, args: {
	filePath: string;
	lineIndex: number;
	originalLine: string;
	checked: boolean;
	text: string;
}) {
	const { filePath, lineIndex, originalLine, checked, text } = args;
	const file = store.app.vault.getAbstractFileByPath(filePath) as any;
	if (!file) return;

	try {
		store.setSaving(true);
		await store.withSquelch(async () => {
			const content = await store.app.vault.read(file);
			const lines = content.split("\n");
			if (lineIndex < 0 || lineIndex >= lines.length) return;
			const newLine = buildLine(originalLine, checked, (text ?? "").trim());
			if (lines[lineIndex] === newLine) return;
			lines[lineIndex] = newLine;
			await store.app.vault.modify(file, lines.join("\n"));
		});
	} finally {
		store.setSaving(false);
		// don't mark clean here; batch save may still be pending
	}
}

export async function createNewTaskAtEnd(store: Store, filePath: string, text: string) {
	const file = store.app.vault.getAbstractFileByPath(filePath) as any;
	if (!file) return;

	try {
		store.setSaving(true);
		const scroller = store.ui?.scroller;
		const prevScroll = scroller?.scrollTop ?? 0;

		await store.withSquelch(async () => {
			const content = await store.app.vault.read(file);
			const lines = content.length ? content.split("\n") : [];

			// insert before a trailing empty line if present
			let insertAt = lines.length;
			if (insertAt > 0 && lines[insertAt - 1] === "") insertAt = insertAt - 1;

			const newLine = `- [ ] ${text}`;
			lines.splice(insertAt, 0, newLine);
			const out = lines.join("\n");
			await store.app.vault.modify(file, out.endsWith("\n") ? out : out + "\n");

			// focus the newly created item after remount
			store.pendingFocusId = `${filePath}::${insertAt}`;
		});

		// ⬇️ DO THE REMOUNT AFTER squelch so focus can be applied
		await mountTable(store);

		if (scroller) scroller.scrollTop = prevScroll;
	} finally {
		store.setSaving(false);
	}
}
