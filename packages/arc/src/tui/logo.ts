/**
 * Arc's logo for the banner: a 14 × 24 pixel bitmap drawn with half blocks (two pixels per character, top and
 * bottom), so it takes 14 columns and 12 lines. It is colored with a gradient from pink at the top through purple to
 * blue at the bottom, leaning slightly left to right. Unlike the rest of the UI, which follows the terminal's own
 * palette, the logo has fixed colors.
 */
const LOGO_PIXELS = [
	".......#......",
	".......#......",
	".......#......",
	"......##......",
	"......##......",
	"......##......",
	".....####.....",
	".....####.....",
	"....#####.....",
	"....#####.....",
	"#...######....",
	"#..#######....",
	"###########...",
	"############..",
	"##############",
	"##############",
	"#############.",
	".####..#####..",
	".###....####..",
	"..##....###...",
	".......###....",
	"......###.....",
	"......##......",
	"..............",
] as const;

export const LOGO_WIDTH = LOGO_PIXELS[0].length;
export const LOGO_LINES = LOGO_PIXELS.length / 2;

type Rgb = readonly [number, number, number];

/** Top to bottom. */
const GRADIENT: readonly Rgb[] = [
	[236, 72, 200],
	[150, 92, 240],
	[80, 180, 236],
];

export type LogoColors = "truecolor" | "256" | "none";

/** What the terminal can show: 24-bit color when it says so, the 256-color palette otherwise, none with NO_COLOR. */
export function logoColors(env: NodeJS.ProcessEnv = process.env): LogoColors {
	if (env.NO_COLOR) return "none";
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	return colorterm === "truecolor" || colorterm === "24bit" ? "truecolor" : "256";
}

function gradientAt(t: number): Rgb {
	const scaled = Math.min(1, Math.max(0, t)) * (GRADIENT.length - 1);
	const i = Math.min(GRADIENT.length - 2, Math.floor(scaled));
	const f = scaled - i;
	const [a, b] = [GRADIENT[i], GRADIENT[i + 1]];
	const mix = (k: 0 | 1 | 2) => Math.round(a[k] + (b[k] - a[k]) * f);
	return [mix(0), mix(1), mix(2)];
}

/** The nearest color of the 256-color palette's 6 × 6 × 6 cube. */
function to256([r, g, b]: Rgb): number {
	const level = (v: number) => Math.round((v / 255) * 5);
	return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function sgrColor(rgb: Rgb, colors: LogoColors, layer: "fg" | "bg"): string {
	const base = layer === "fg" ? 38 : 48;
	return colors === "truecolor" ? `\x1b[${base};2;${rgb.join(";")}m` : `\x1b[${base};5;${to256(rgb)}m`;
}

/** The logo's lines, each exactly `LOGO_WIDTH` columns wide. */
export function renderLogo(colors: LogoColors = logoColors()): string[] {
	const height = LOGO_PIXELS.length;
	const colorOf = (x: number, y: number) => gradientAt(0.3 * (x / (LOGO_WIDTH - 1)) + 0.7 * (y / (height - 1)));
	const lines: string[] = [];
	for (let y = 0; y < height; y += 2) {
		let line = "";
		for (let x = 0; x < LOGO_WIDTH; x++) {
			const top = LOGO_PIXELS[y][x] === "#";
			const bottom = LOGO_PIXELS[y + 1][x] === "#";
			if (!top && !bottom) {
				line += " ";
			} else if (colors === "none") {
				line += top && bottom ? "█" : top ? "▀" : "▄";
			} else if (top && bottom) {
				// Upper half in the foreground color, lower half in the background color: two pixels, two colors.
				line += `${sgrColor(colorOf(x, y), colors, "fg")}${sgrColor(colorOf(x, y + 1), colors, "bg")}▀\x1b[39;49m`;
			} else {
				const pixel = top ? y : y + 1;
				line += `${sgrColor(colorOf(x, pixel), colors, "fg")}${top ? "▀" : "▄"}\x1b[39m`;
			}
		}
		lines.push(line);
	}
	return lines;
}

/** The banner's section headings: omp's sky blue, fixed like the logo's colors rather than the theme's blue. */
const ACCENT: Rgb = [79, 168, 240];

/** `text` in the accent color, or plain with NO_COLOR. */
export function accent(text: string, colors: LogoColors = logoColors()): string {
	return colors === "none" ? text : `${sgrColor(ACCENT, colors, "fg")}${text}\x1b[39m`;
}
