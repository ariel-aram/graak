import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error the runtime files are plain JavaScript without declarations
import { graphemeBreaks, Segmenter, wordBreaks } from "../quickjs/runtime/segmenter.js";

/**
 * Cases drawn from Unicode's GraphemeBreakTest.txt and WordBreakTest.txt, which the full
 * implementation passes completely (1187/1187 and 1826/1826 when run against the published
 * files). These are the ones that distinguish a real UAX #29 implementation from splitting by
 * code point, which is what this runtime used to refuse to ship.
 */
test("grapheme segmentation keeps emoji ZWJ sequences whole", () => {
	// Family emoji: four pictographs joined by ZWJ is one grapheme (GB11).
	const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
	assert.deepEqual(graphemeBreaks(family), [0, family.length]);
	assert.equal([...new Segmenter("en").segment(family)].length, 1);
});

test("grapheme segmentation pairs regional indicators into flags", () => {
	// Two regional indicators are one flag; three are a flag plus a stray (GB12/GB13).
	const oneFlag = "\u{1F1E6}\u{1F1E7}";
	assert.deepEqual(graphemeBreaks(oneFlag), [0, 4]);
	const flagPlus = "\u{1F1E6}\u{1F1E7}\u{1F1E8}";
	assert.deepEqual(graphemeBreaks(flagPlus), [0, 4, 6]);
});

test("grapheme segmentation keeps combining marks with their base", () => {
	const eAcute = "é";
	assert.deepEqual(graphemeBreaks(eAcute), [0, 2]);
	// Compared against the decomposed sequence, not a precomposed literal: the point is that the
	// base and its combining mark stay in one segment, not that they normalise.
	const segments = [...new Segmenter("en").segment(`${eAcute}x`)].map((s) => s.segment);
	assert.deepEqual(segments, [eAcute, "x"]);
});

test("grapheme segmentation applies GB9c to Indic conjuncts", () => {
	// Devanagari KA + VIRAMA + TA is a single conjunct cluster under Unicode 15.1's GB9c.
	// Without that rule this splits into two, which is the bug the rule was added to fix.
	const conjunct = "क्त";
	assert.deepEqual(graphemeBreaks(conjunct), [0, 3]);
});

test("grapheme segmentation never splits a CRLF pair", () => {
	assert.deepEqual(graphemeBreaks("a\r\nb"), [0, 1, 3, 4]);
});

test("word segmentation separates words from punctuation and spaces", () => {
	const segments = [...new Segmenter("en", { granularity: "word" }).segment("Hello, world!")];
	assert.deepEqual(
		segments.map((s) => s.segment),
		["Hello", ",", " ", "world", "!"]
	);
	assert.deepEqual(
		segments.filter((s) => s.isWordLike).map((s) => s.segment),
		["Hello", "world"]
	);
});

test("word segmentation keeps numbers and contractions together", () => {
	assert.deepEqual(
		[...new Segmenter("en", { granularity: "word" }).segment("3,000.50")].map((s) => s.segment),
		["3,000.50"]
	);
	assert.deepEqual(
		[...new Segmenter("en", { granularity: "word" }).segment("don't")].map((s) => s.segment),
		["don't"]
	);
});

test("word segmentation breaks a space that carries a combining mark", () => {
	// WB3d (WSegSpace x WSegSpace) is ordered before the ignore rule, so an Extend between two
	// spaces does break them. Getting the rule order wrong silently merges them.
	assert.deepEqual(wordBreaks(" ̈ "), [0, 2, 3]);
});

test("sentence granularity is refused rather than approximated", () => {
	// Sentence rules are locale-tailorable; one untailored implementation would be wrong for the
	// locales that need tailoring, so it says so instead of guessing.
	assert.throws(() => new Segmenter("en", { granularity: "sentence" }), /not implemented/);
	assert.throws(() => new Segmenter("en", { granularity: "nonsense" }), /invalid granularity/);
});

test("resolvedOptions reports what was actually selected", () => {
	assert.deepEqual(new Segmenter("fr", { granularity: "word" }).resolvedOptions(), {
		locale: "fr",
		granularity: "word",
	});
});
