export const rootTokenFromLine = (line: string): string => {
	const m = line.match(/^\s*[-*]\s\[[ xX]\]\s(.+?)\s*$/);
	return (m?.[1] ?? line.trim()).toLowerCase();
};

export const getIndentDepth = (line: string): number => {
	const m = line.match(/^(\s*)[-*]\s\[[ xX]\]\s/);
	if (!m) return 1;
	const lead = m[1] ?? "";
	const tabs = (lead.match(/\t/g) || []).length;
	const spaces = lead.replace(/\t/g, "").length;
	// treat every full 2 spaces as one level, plus each tab as one level
	return 1 + tabs + Math.floor(spaces / 2);
};


export const buildLine = (originalLine: string, checked: boolean, text: string): string => {
	const m = originalLine.match(/^(\s*[-*]\s)\[( |x|X)\]\s(.+)$/);
	if (m) return `${m[1]}[${checked ? "x" : " "}] ${text}`;
	return `- [${checked ? "x" : " "}] ${text}`;
};

export const lineWithDepth = (originalLine: string, newDepth: number): string => {
	const indent = "\t".repeat(Math.max(0, newDepth - 1));
	const m = originalLine.match(/^(\s*)([-*]\s\[[ xX]\]\s)(.+)$/);
	if (m) return `${indent}${m[2]}${m[3]}`;
	const m2 = originalLine.match(/^\s*[-*]\s\[( |x|X)\]\s(.+)$/);
	const checked = m2 ? m2[1].toLowerCase() === "x" : false;
	const text = m2 ? m2[2] : originalLine.trim();
	return `${indent}- [${checked ? "x" : " "}] ${text}`;
};

export const hsl = (h: number, s: number, l: number) =>
	`hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;

export const TASK_RX = /^\s*[-*]\s\[[ xX]\]\s.+/;
