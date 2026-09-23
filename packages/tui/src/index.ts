// The parts of pi-tui that Arc uses: the main-screen renderer, the editor, markdown, select lists, and text helpers.

export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "./components/select-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { type KeyId, matchesKey } from "./keys.ts";
export { ProcessTerminal, type Terminal } from "./terminal.ts";
export { type Component, Container, type Focusable, type TUI, type TuiInputListenerResult } from "./tui.ts";
export { TuiMainScreen } from "./tui-main-screen.ts";
export { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.ts";
