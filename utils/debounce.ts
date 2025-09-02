export const debounce = <T extends (...a: any[]) => any>(fn: T, wait: number) => {
	let t: number | undefined;
	return (...args: Parameters<T>) => {
		if (t) window.clearTimeout(t);
		t = window.setTimeout(() => fn(...args), wait);
	};
};
