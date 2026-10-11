import assert from "node:assert";
import { describe, it } from "node:test";
import { latexToUnicode } from "../src/latex.ts";

describe("latexToUnicode", () => {
	it("converts integrals, spacing and scripts", () => {
		assert.strictEqual(latexToUnicode(String.raw`\iiint_E f(x,y,z)\,dV`), "∭_E f(x,y,z) dV");
		assert.strictEqual(latexToUnicode(String.raw`\int_0^1 x^2\,dx`), "∫₀¹ x² dx");
		assert.strictEqual(latexToUnicode(String.raw`\sum_{i=1}^{n} i`), "∑ᵢ₌₁ⁿ i");
		assert.strictEqual(latexToUnicode(String.raw`\int_{-\infty}^{\infty}`), "∫_(-∞)^∞");
	});

	it("falls back to explicit scripts when a character has no Unicode form", () => {
		assert.strictEqual(latexToUnicode("e^{i\\pi}"), "e^(iπ)");
		assert.strictEqual(latexToUnicode("x_{}"), "x");
	});

	it("converts fractions, roots, fonts and accents", () => {
		assert.strictEqual(latexToUnicode(String.raw`\frac{x+1}{2}`), "(x+1)/2");
		assert.strictEqual(latexToUnicode(String.raw`\frac{n(n+1)}{2}`), "n(n+1)/2");
		assert.strictEqual(latexToUnicode(String.raw`\frac{dy}{dx}`), "dy/dx");
		assert.strictEqual(latexToUnicode(String.raw`\sqrt{x^2+1}`), "√(x²+1)");
		assert.strictEqual(latexToUnicode(String.raw`\sqrt[3]{8}`), "∛8");
		assert.strictEqual(latexToUnicode(String.raw`\mathbb{R}^3`), "ℝ³");
		assert.strictEqual(latexToUnicode(String.raw`\vec{F} \cdot \nabla`), "F⃗ · ∇");
		assert.strictEqual(latexToUnicode(String.raw`90^\circ`), "90°");
		assert.strictEqual(latexToUnicode(String.raw`\text{if } x > 0`), "if x > 0");
	});

	it("drops sizing commands and breaks lines at \\\\", () => {
		const aligned = String.raw`\begin{aligned} x &= \rho \sin\phi \\ z &= \rho \cos\phi \end{aligned}`;
		assert.strictEqual(latexToUnicode(aligned), "x = ρ sin φ\nz = ρ cos φ");
		assert.strictEqual(latexToUnicode(String.raw`\left( \frac{a}{b} \right.`), "( a/b");
	});

	it("leaves unknown commands as written", () => {
		assert.strictEqual(latexToUnicode(String.raw`\unknowncmd{x}`), "\\unknowncmd{x}");
		assert.strictEqual(latexToUnicode(String.raw`\constructor`), "\\constructor");
	});
});
