// LaTeX math to plain Unicode text. A terminal cannot typeset math, and models answer math questions in LaTeX:
// `\iiint_E f(x,y,z)\,dV` printed as-is is hard to read, so it is shown as `∭_E f(x,y,z) dV` instead.
// This covers the symbols, scripts, fractions, roots, accents and font commands that appear in answers.
// Anything it does not know stays as written.

const SYMBOLS: Record<string, string> = {
	// Greek
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	// Big operators
	int: "∫",
	iint: "∬",
	iiint: "∭",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	bigcup: "⋃",
	bigcap: "⋂",
	bigoplus: "⨁",
	bigotimes: "⨂",
	// Calculus and sets
	nabla: "∇",
	partial: "∂",
	infty: "∞",
	emptyset: "∅",
	varnothing: "∅",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	in: "∈",
	notin: "∉",
	ni: "∋",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	cup: "∪",
	cap: "∩",
	setminus: "∖",
	aleph: "ℵ",
	hbar: "ħ",
	ell: "ℓ",
	Re: "ℜ",
	Im: "ℑ",
	wp: "℘",
	// Binary operators and relations
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	cdot: "·",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "•",
	oplus: "⊕",
	otimes: "⊗",
	wedge: "∧",
	land: "∧",
	vee: "∨",
	lor: "∨",
	neg: "¬",
	lnot: "¬",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	leqslant: "⩽",
	geqslant: "⩾",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	equiv: "≡",
	sim: "∼",
	simeq: "≃",
	cong: "≅",
	propto: "∝",
	ll: "≪",
	gg: "≫",
	prec: "≺",
	succ: "≻",
	perp: "⊥",
	parallel: "∥",
	mid: "∣",
	vdash: "⊢",
	models: "⊨",
	top: "⊤",
	bot: "⊥",
	// Arrows
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	gets: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	mapsto: "↦",
	longrightarrow: "⟶",
	longleftarrow: "⟵",
	uparrow: "↑",
	downarrow: "↓",
	// Delimiters and dots
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	vert: "|",
	lvert: "|",
	rvert: "|",
	Vert: "‖",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	cdots: "⋯",
	ldots: "…",
	dots: "…",
	vdots: "⋮",
	ddots: "⋱",
	// Misc
	angle: "∠",
	triangle: "△",
	square: "□",
	Box: "□",
	diamond: "⋄",
	therefore: "∴",
	because: "∵",
	prime: "′",
	degree: "°",
	dagger: "†",
	colon: ":",
	quad: " ",
	qquad: "  ",
};

/** Commands printed as their name, such as `\sin`. */
const FUNCTIONS = new Set([
	"sin",
	"cos",
	"tan",
	"cot",
	"sec",
	"csc",
	"arcsin",
	"arccos",
	"arctan",
	"sinh",
	"cosh",
	"tanh",
	"log",
	"ln",
	"lg",
	"exp",
	"lim",
	"liminf",
	"limsup",
	"max",
	"min",
	"sup",
	"inf",
	"det",
	"dim",
	"ker",
	"deg",
	"gcd",
	"arg",
	"Pr",
	"mod",
	"bmod",
]);

/** Sizing and spacing commands that only matter to a typesetter. */
const IGNORED = new Set([
	"left",
	"right",
	"middle",
	"big",
	"Big",
	"bigg",
	"Bigg",
	"bigl",
	"bigr",
	"Bigl",
	"Bigr",
	"biggl",
	"biggr",
	"Biggl",
	"Biggr",
	"displaystyle",
	"textstyle",
	"scriptstyle",
	"limits",
	"nolimits",
	"nonumber",
	"notag",
]);

/** Commands whose argument is plain text, shown verbatim. */
const TEXT_COMMANDS = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "mbox", "hbox", "emph"]);

/** Font commands whose argument is still math. */
const FONT_COMMANDS = new Set(["mathrm", "mathit", "mathbf", "mathsf", "mathtt", "boldsymbol", "bm", "operatorname"]);

/** Combining characters for accents: `\vec{v}` is v⃗. */
const ACCENTS: Record<string, string> = {
	vec: "⃗",
	overrightarrow: "⃗",
	hat: "̂",
	widehat: "̂",
	bar: "̄",
	overline: "̅",
	tilde: "̃",
	widetilde: "̃",
	dot: "̇",
	ddot: "̈",
};

const SUPERSCRIPTS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	θ: "ᶿ",
	φ: "ᵠ",
	χ: "ᵡ",
};

const SUBSCRIPTS: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

const SUPERSCRIPT_CHARS = new Set(Object.values(SUPERSCRIPTS));
const SUBSCRIPT_CHARS = new Set(Object.values(SUBSCRIPTS));

/** Letters with their own code points outside the Mathematical Alphanumeric Symbols block. */
const DOUBLE_STRUCK: Record<string, string> = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const SCRIPT: Record<string, string> = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
const FRAKTUR: Record<string, string> = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };

/** Map A-Z (and a-z when `lower` is given) into a Unicode math alphabet starting at `upper`. */
function alphabet(text: string, special: Record<string, string>, upper: number, lower?: number): string {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (special[ch]) out += special[ch];
		else if (code >= 65 && code <= 90) out += String.fromCodePoint(upper + code - 65);
		else if (lower !== undefined && code >= 97 && code <= 122) out += String.fromCodePoint(lower + code - 97);
		else out += ch;
	}
	return out;
}

/** Whether a fraction part needs parentheses to stay unambiguous: `\frac{a+b}{c}` is (a+b)/c, `\frac{n(n+1)}{2}` is n(n+1)/2. */
function needsParens(text: string): boolean {
	let depth = 0;
	for (const ch of text) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (depth === 0 && /[\s+\-−=±∓×·/<>≤≥]/.test(ch)) return true;
	}
	return false;
}

class LatexReader {
	private pos = 0;
	private readonly src: string;

	constructor(src: string) {
		this.src = src;
	}

	/** Read until `close` (left unconsumed) or the end. */
	readSequence(close?: string): string {
		let out = "";
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos]!;
			if (close && ch === close) break;
			out += this.readItem();
		}
		return out;
	}

	private readItem(): string {
		const ch = this.src[this.pos]!;
		if (ch === "{") return this.readGroup();
		if (ch === "}") {
			this.pos++;
			return "";
		}
		if (ch === "\\") return this.readCommand();
		if (ch === "^" || ch === "_") {
			this.pos++;
			return script(this.readArgument(), ch);
		}
		if (/\s/.test(ch)) {
			while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
			return " ";
		}
		this.pos++;
		if (ch === "~") return " ";
		if (ch === "&") return " ";
		if (ch === "'") return "′";
		return ch;
	}

	private readGroup(): string {
		this.pos++;
		const out = this.readSequence("}");
		if (this.src[this.pos] === "}") this.pos++;
		return out;
	}

	/** One argument: a braced group, a command, or a single character. */
	private readArgument(): string {
		while (this.src[this.pos] === " ") this.pos++;
		const ch = this.src[this.pos];
		if (ch === undefined) return "";
		if (ch === "{") return this.readGroup();
		if (ch === "\\") return this.readCommand();
		this.pos++;
		return ch;
	}

	/** A braced argument taken verbatim, for `\text{...}` and environment names. */
	private readRawArgument(): string {
		while (this.src[this.pos] === " ") this.pos++;
		if (this.src[this.pos] !== "{") return this.readArgument();
		let depth = 0;
		const start = this.pos + 1;
		for (; this.pos < this.src.length; this.pos++) {
			const ch = this.src[this.pos];
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) break;
		}
		const out = this.src.slice(start, this.pos);
		this.pos++;
		return out;
	}

	private readOptional(): string | undefined {
		if (this.src[this.pos] !== "[") return undefined;
		this.pos++;
		const out = this.readSequence("]");
		if (this.src[this.pos] === "]") this.pos++;
		return out;
	}

	private readCommand(): string {
		this.pos++;
		const first = this.src[this.pos];
		if (first === undefined) return "\\";
		if (!/[a-zA-Z]/.test(first)) {
			this.pos++;
			switch (first) {
				case "\\":
					return "\n";
				case ",":
				case ":":
				case ";":
				case ">":
				case " ":
					return " ";
				case "!":
					return "";
				case "|":
					return "‖";
				default:
					return first;
			}
		}
		const name = /^[a-zA-Z]+/.exec(this.src.slice(this.pos))![0];
		this.pos += name.length;
		if (this.src[this.pos] === "*") this.pos++;

		if (Object.hasOwn(SYMBOLS, name)) return SYMBOLS[name]!;
		if (FUNCTIONS.has(name)) {
			// `\sin\theta` and `\log x`: keep the name apart from what follows.
			return /[a-zA-Z0-9\\]/.test(this.src[this.pos] ?? "") ? `${name} ` : name;
		}
		if (IGNORED.has(name)) {
			// `\left.` and `\right.` are invisible delimiters.
			if ((name === "left" || name === "right") && this.src[this.pos] === ".") this.pos++;
			return "";
		}
		if (TEXT_COMMANDS.has(name)) return this.readRawArgument();
		if (FONT_COMMANDS.has(name)) return this.readArgument();
		if (name === "mathbb") return alphabet(this.readArgument(), DOUBLE_STRUCK, 0x1d538, 0x1d552);
		if (name === "mathcal" || name === "mathscr") return alphabet(this.readArgument(), SCRIPT, 0x1d49c);
		if (name === "mathfrak") return alphabet(this.readArgument(), FRAKTUR, 0x1d504, 0x1d51e);
		const accent = Object.hasOwn(ACCENTS, name) ? ACCENTS[name] : undefined;
		if (accent) return [...this.readArgument()].map((ch) => (ch === " " ? ch : ch + accent)).join("");
		switch (name) {
			case "frac":
			case "dfrac":
			case "tfrac":
			case "cfrac": {
				const numerator = this.readArgument().trim();
				const denominator = this.readArgument().trim();
				const wrap = (part: string) => (needsParens(part) ? `(${part})` : part);
				return `${wrap(numerator)}/${wrap(denominator)}`;
			}
			case "binom":
			case "dbinom":
			case "tbinom": {
				const n = this.readArgument().trim();
				const k = this.readArgument().trim();
				return `C(${n}, ${k})`;
			}
			case "sqrt": {
				const index = this.readOptional()?.trim();
				const body = this.readArgument().trim();
				const root = index === "3" ? "∛" : index === "4" ? "∜" : index ? `${script(index, "^")}√` : "√";
				return [...body].length > 1 ? `${root}(${body})` : `${root}${body}`;
			}
			case "begin":
			case "end":
				this.readRawArgument();
				return "";
			case "tag":
				return ` (${this.readRawArgument()})`;
			case "label":
				this.readRawArgument();
				return "";
		}
		// Unknown: show it as written, braces included, rather than run its argument into the name.
		let out = `\\${name}`;
		while (this.src[this.pos] === "{") out += `{${this.readRawArgument()}}`;
		return out;
	}
}

/** `x^{2}` is x²; when a character has no superscript form, `e^{iπ}` is e^(iπ). */
function script(arg: string, marker: "^" | "_"): string {
	const trimmed = arg.trim();
	if (marker === "^" && trimmed === "∘") return "°";
	if (/^′+$/.test(trimmed)) return trimmed;
	const map = marker === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
	const already = marker === "^" ? SUPERSCRIPT_CHARS : SUBSCRIPT_CHARS;
	const chars = [...trimmed.replace(/\s+/g, "")];
	if (chars.length === 0) return "";
	if (chars.every((ch) => map[ch] || already.has(ch))) {
		return chars.map((ch) => map[ch] ?? ch).join("");
	}
	return chars.length === 1 ? `${marker}${trimmed}` : `${marker}(${trimmed})`;
}

/** Convert LaTeX math (without its `$` delimiters) to Unicode text. Lines break at `\\`. */
export function latexToUnicode(latex: string): string {
	return new LatexReader(latex)
		.readSequence()
		.split("\n")
		.map((line) => line.replace(/ {2,}/g, " ").trim())
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

/** Whether `\name` is a command this converter knows, so bare LaTeX in prose can be converted safely. */
export function isKnownLatexCommand(name: string): boolean {
	return (
		Object.hasOwn(SYMBOLS, name) ||
		FUNCTIONS.has(name) ||
		TEXT_COMMANDS.has(name) ||
		FONT_COMMANDS.has(name) ||
		Object.hasOwn(ACCENTS, name) ||
		["mathbb", "mathcal", "mathscr", "mathfrak", "frac", "dfrac", "tfrac", "sqrt", "binom"].includes(name)
	);
}
