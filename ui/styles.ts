import type { ItemView } from "obsidian";

export function createStyles(view: ItemView) {
	const style = document.createElement("style");
	style.textContent = `
.tt-md { padding: 0 !important; }
.tt-md p, .tt-md ul, .tt-md ol, .tt-md blockquote,
.tt-md h1, .tt-md h2, .tt-md h3, .tt-md h4, .tt-md h5, .tt-md h6,
.tt-md .callout, .tt-md .internal-embed, .tt-md .media-embed { margin: 0 !important; }
.tt-md ul, .tt-md ol { padding-inline-start: 1.1em; }
.task-row { border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
.task-row.hover-top { border-top-color: var(--text-accent); }
.task-row.hover-bottom { border-bottom-color: var(--text-accent); }
.task-cell { border-bottom: 1px solid var(--background-modifier-border); }
.task-new .placeholder { color: var(--text-muted); }
.task-new .plus { display:inline-flex; align-items:center; justify-content:center;
  width:1.5em; min-width:1.5em; height:1.5em; border-radius:4px; font-weight:700; opacity:0.7; user-select:none; }

/* Center everything vertically in the left row */
.row-wrap { display:flex; align-items:center; gap:6px; min-width:0; }

/* Remove the vertical nudge that was pushing things down */
.row-wrap .num,
.row-wrap input[type="checkbox"] { margin-top: 0; }

/* (Optional) ensure checkbox lines up nicely across themes */
.row-wrap input[type="checkbox"] { vertical-align: middle; }

.task-edit, .task-preview { font-size: var(--font-ui-medium, 14px); line-height: 1.4; }
`;
	document.head.appendChild(style);
	(view as any)._tt_dispose = () => style.remove();
}
