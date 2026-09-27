/**
 * The collation half of tools/gen-intl-data.js: weights for the characters ICU's root collation orders explicitly, and how
 * each locale's tailoring differs, both read out of Node's own ICU by comparing characters.
 *
 * Every character that has no decomposition gets three numbers: a primary weight (which letter), a secondary one (which
 * accent variant) and a tertiary one (which case or width variant). They are stored as one string in collation order, with
 * private-use separators marking where a weight changes, so the weights are recovered by counting. A few characters are
 * expansions (the German sharp s sorts as "ss"). A locale's tailoring is a list of letters it orders differently from the
 * root, each with a weight placed after an ASCII letter (Swedish "å" after "z"), stored as the letter's decomposition.
 */

// U+E000..E00F are private use: they never appear in the table, so they can separate its groups.
const PRIMARY = "";
const SECONDARY = "";
const TERTIARY = "";

function characters() {
	const out = [];
	const add = (from, to) => {
		for (let cp = from; cp <= to; cp++) {
			if (cp >= 0xd800 && cp <= 0xdfff) continue;
			const c = String.fromCodePoint(cp);
			if (/\p{Cn}|\p{Co}|\p{Cs}/u.test(c)) continue;
			out.push(c);
		}
	};
	add(0x0000, 0x33ff);
	add(0xfb00, 0xffef);
	add(0x1f000, 0x1faff);
	return out;
}

function collationData(locales) {
	const root = (options) => new Intl.Collator("en", options);
	const primary = root({ sensitivity: "base" });
	const accent = root({ sensitivity: "accent" });
	const variant = root({ sensitivity: "variant" });
	const shifted = root({ ignorePunctuation: true });
	const all = characters();

	const atomic = [];
	const ignorable = [];
	const marks = [];
	const compat = {};
	for (const c of all) {
		if (variant.compare("a", `a${c}`) === 0) {
			ignorable.push(c);
			continue;
		}
		if (c.normalize("NFD") !== c) continue;
		if (c.normalize("NFKD") !== c) {
			compat[c] = c.normalize("NFKD");
			continue;
		}
		if (primary.compare("a", `a${c}`) === 0) {
			marks.push(c);
			continue;
		}
		atomic.push(c);
	}

	// Characters that sort as the letters of a longer string: "ß" as "ss", "æ" as "ae".
	const lowerPairs = [];
	for (const a of "abcdefghijklmnopqrstuvwxyz") for (const b of "abcdefghijklmnopqrstuvwxyz") lowerPairs.push(a + b);
	const sorted = atomic.slice().sort((x, y) => primary.compare(x, y) || (x < y ? -1 : 1));
	const groupsOf = (list, collator) => {
		const groups = [];
		for (const c of list) {
			const last = groups[groups.length - 1];
			if (last && collator.compare(last[0], c) === 0) last.push(c);
			else groups.push([c]);
		}
		return groups;
	};
	const expansions = {};
	// A character that sorts equal to two letters ("ß" and "ẞ" as "ss", "æ" as "ae") is an expansion of them.
	const latin = /[\u00c0-\u024f\u1e00-\u1eff]/;
	const pairEquals = (c) => lowerPairs.find((p) => primary.compare(c, p) === 0);
	const expandable = new Set();
	for (const c of atomic) {
		if (!latin.test(c)) continue;
		const pair = pairEquals(c);
		if (pair) {
			expansions[c] = pair;
			expandable.add(c);
		}
	}
	const primaryGroups = groupsOf(
		sorted.filter((c) => !expandable.has(c)),
		primary
	);

	const inOrder = (group, collator) => group.slice().sort((x, y) => collator.compare(x, y) || (x < y ? -1 : 1));
	let orderString = "";
	primaryGroups.forEach((group, pi) => {
		if (pi) orderString += PRIMARY;
		const bySecondary = groupsOf(inOrder(group, accent), accent);
		bySecondary.forEach((secondaryClass, si) => {
			if (si) orderString += SECONDARY;
			const byTertiary = groupsOf(inOrder(secondaryClass, variant), variant);
			byTertiary.forEach((tertiaryClass, ti) => {
				if (ti) orderString += TERTIARY;
				orderString += tertiaryClass.join("");
			});
		});
	});

	// Combining marks in order of their secondary weight.
	const markOrder = groupsOf(
		marks.slice().sort((x, y) => accent.compare(`a${x}`, `a${y}`) || (x < y ? -1 : 1)),
		{ compare: (x, y) => accent.compare(`a${x}`, `a${y}`) }
	);
	const marksString = markOrder.map((g) => g.join("")).join(SECONDARY);

	const markSet = new Set(marks);
	const variable = all
		.filter((c) => variant.compare("a", `a${c}`) !== 0 && shifted.compare("a", `a${c}`) === 0 && !markSet.has(c))
		.join("");

	// Digits: the code point of each block's zero.
	const digitZeros = [];
	for (const c of all) {
		const cp = c.codePointAt(0);
		if (/\p{Nd}/u.test(c) && !digitZeros.includes(cp - 1) && !(cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))))
			digitZeros.push(cp);
	}

	// Tailoring: a letter is tailored when its position among the ASCII letters differs from the root's.
	// Scripts a locale sorts before Latin (Cyrillic in Russian, Han in Chinese, Hangul and Han in Korean).
	const REORDERABLE = [
		["Cyrillic", "\u0430"],
		["Greek", "\u03b1"],
		["Hangul", "\uac00"],
		["Han", "\u4e2d"],
		["Hiragana", "\u3042"],
		["Katakana", "\u30a2"],
		["Arabic", "\u0627"],
		["Hebrew", "\u05d0"],
		["Thai", "\u0e01"],
		["Devanagari", "\u0915"],
	];
	const atomicSet = new Set(atomic);
	const asciiLetters = [..."abcdefghijklmnopqrstuvwxyz"];
	const nfcLetters = all.filter(
		(c) =>
			/\p{L}/u.test(c) &&
			c.codePointAt(0) > 0x7f &&
			c.codePointAt(0) <= 0x1eff &&
			(c.normalize("NFD") !== c || atomicSet.has(c))
	);
	const uppercase = (c) => c !== c.toLowerCase();
	const tailoring = {};
	const reorder = {};
	for (const locale of locales) {
		const collator = new Intl.Collator(locale, { sensitivity: "base" });
		const moved = REORDERABLE.filter(([, rep]) => collator.compare(rep, "a") < 0).sort((x, y) =>
			collator.compare(x[1], y[1])
		);
		if (moved.length) reorder[locale] = moved.map(([name]) => name);
		const movedPattern = moved.length ? new RegExp(moved.map(([name]) => `\\p{Script=${name}}`).join("|"), "u") : null;
		const accentL = new Intl.Collator(locale, { sensitivity: "accent" });
		const variantL = new Intl.Collator(locale, { sensitivity: "variant" });
		const signature = (c, collate) => asciiLetters.map((x) => Math.sign(collate.compare(c, x))).join("");
		const tailoredAscii = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter(
			(c) => signature(c, collator) !== signature(c, primary)
		);
		let changed = [...tailoredAscii, ...nfcLetters].filter(
			(c) => !movedPattern?.test(c) && signature(c, collator) !== signature(c, primary)
		);
		// A letter built on a tailored one (Turkish "İ" is "I" and a dot) has to follow it.
		if (tailoredAscii.length)
			changed = [...new Set([...changed, ...nfcLetters.filter((c) => tailoredAscii.includes(c.normalize("NFD")[0]))])];
		if (!changed.length) {
			continue;
		}
		// Pick the ASCII letter each one follows, or is equal to.
		const rows = changed.map((c) => {
			const equal = asciiLetters.find((x) => collator.compare(c, x) === 0);
			const follows = equal ?? [...asciiLetters].reverse().find((x) => collator.compare(x, c) < 0) ?? "";
			return { c, equal, follows: follows || "" };
		});
		const entries = {};
		const byAnchor = new Map();
		for (const row of rows) {
			const key = row.equal ? `=${row.equal}` : `>${row.follows}`;
			if (!byAnchor.has(key)) byAnchor.set(key, []);
			byAnchor.get(key).push(row);
		}
		for (const [key, list] of byAnchor) {
			const anchor = key.slice(1);
			const groups = groupsOf(
				list
					.map((r) => r.c)
					.sort(
						(x, y) => collator.compare(x, y) || accentL.compare(x, y) || variantL.compare(x, y) || (x < y ? -1 : 1)
					),
				collator
			);
			groups.forEach((group, gi) => {
				const members = key[0] === "=" ? [anchor, anchor.toUpperCase(), ...group] : group;
				const sortedMembers = members
					.slice()
					.sort((x, y) => accentL.compare(x, y) || variantL.compare(x, y) || (x < y ? -1 : 1));
				const bySecondary = groupsOf(sortedMembers, accentL);
				for (const c of group) {
					const s = bySecondary.findIndex((g) => g.includes(c));
					const t = groupsOf(
						bySecondary[s].slice().sort((x, y) => variantL.compare(x, y) || (x < y ? -1 : 1)),
						variantL
					).findIndex((g) => g.includes(c));
					entries[c.normalize("NFD")] =
						key[0] === "=" ? { same: anchor, s, t } : { after: anchor, n: gi + 1, of: groups.length, s, t };
				}
			});
		}
		tailoring[locale] = entries;
		void uppercase;
	}

	// Han: the order in which each CJK language sorts the unified ideographs.
	const han = {};
	const hanChars = [];
	for (let cp = 0x4e00; cp <= 0x9fff; cp++) hanChars.push(String.fromCodePoint(cp));
	for (const locale of locales.filter((l) => ["zh", "ja", "ko"].includes(l.split("-")[0]))) {
		const collator = new Intl.Collator(locale, { sensitivity: "variant" });
		const primaryOnly = new Intl.Collator(locale, { sensitivity: "base" });
		const list = hanChars.slice().sort((x, y) => collator.compare(x, y) || (x < y ? -1 : 1));
		han[locale] = groupsOf(list, primaryOnly)
			.map((g) => g.join(""))
			.join(PRIMARY);
	}

	return {
		order: orderString,
		marks: marksString,
		expansions,
		compat,
		reorder,
		ignorable: ignorable.join(""),
		variable,
		digitZeros,
		tailoring,
		han,
		separators: [PRIMARY, SECONDARY, TERTIARY],
	};
}

module.exports = { collationData };
