import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/** https://no-color.org: any non-empty NO_COLOR disables styling. */
const colorEnabled = !process.env.NO_COLOR;

function sgr(open: number, close: number): (text: string) => string {
	return colorEnabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => text;
}

/** The terminal's own 16-color palette, so the UI follows the user's terminal theme. */
export const style = {
	bold: sgr(1, 22),
	dim: sgr(2, 22),
	italic: sgr(3, 23),
	underline: sgr(4, 24),
	strikethrough: sgr(9, 29),
	red: sgr(31, 39),
	green: sgr(32, 39),
	yellow: sgr(33, 39),
	blue: sgr(34, 39),
	magenta: sgr(35, 39),
	cyan: sgr(36, 39),
	gray: sgr(90, 39),
};

export const markdownTheme: MarkdownTheme = {
	heading: (text) => style.bold(style.cyan(text)),
	link: style.blue,
	linkUrl: style.gray,
	code: style.yellow,
	codeBlock: (text) => text,
	codeBlockBorder: style.gray,
	quote: style.italic,
	quoteBorder: style.gray,
	hr: style.gray,
	listBullet: style.cyan,
	bold: style.bold,
	italic: style.italic,
	strikethrough: style.strikethrough,
	underline: style.underline,
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: style.cyan,
	selectedText: style.cyan,
	description: style.gray,
	scrollInfo: style.gray,
	noMatch: style.gray,
};

export const editorTheme: EditorTheme = {
	borderColor: style.gray,
	selectList: selectListTheme,
};
