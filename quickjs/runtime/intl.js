/*
 * ECMA-402 for the native host: Intl.NumberFormat, DateTimeFormat, PluralRules, RelativeTimeFormat, ListFormat, Collator,
 * DisplayNames, DurationFormat and Locale, and the toLocaleString family that sits on them. quickjs-ng has no ICU, so without
 * this `(1234.5).toLocaleString("en-US")` returns "1234.5" and `new Intl.NumberFormat(...)` is not a function.
 *
 * The behaviour is ICU's, read out of it: tools/gen-intl-data.js formats sample values with a full ICU and stores what came out
 * as patterns (number symbols and currency, compact and unit tables, month and weekday names, a pattern for every combination
 * of date and time components, relative-time and list patterns, zone transitions and names, collation weights, display
 * names). This file assembles them and does the arithmetic (decimal rounding, grouping, time zones, plural rules, sort keys),
 * so a formatter answers as ICU does for the 20 locales the data covers, and answers as the closest of them (the language's
 * default region, else en-US) for the rest. The data is read on first use, a locale at a time.
 */
import { civilFromDays, zoneStateAt } from "./intl-zone.js";

const DEFAULT_REGION = { en: "US", de: "DE", fr: "FR", es: "ES", it: "IT", pt: "BR", nl: "NL", sv: "SE", pl: "PL", ru: "RU", tr: "TR", ja: "JP", zh: "CN", ko: "KR" };
const CATEGORY_ORDER = ["zero", "one", "two", "few", "many", "other"];

function installIntl({ global, loadScript, envLocale, envTimeZone }) {
	const IntlObject = global.Intl ?? (global.Intl = {});

	// ---- data ------------------------------------------------------------------------------------------------------
	let shared = null;
	const D = () => {
		if (!shared) {
			loadScript("intl-data.js");
			shared = global.__graak_intl_data;
		}
		return shared;
	};
	const localeCache = {};
	const L = (tag) => {
		if (!localeCache[tag]) {
			if (!global.__graak_intl_locales?.[tag]) loadScript(`intl-${tag}.js`);
			localeCache[tag] = global.__graak_intl_locales[tag];
			localeCache[tag].decoded = new Map();
		}
		return localeCache[tag];
	};
	const namesCache = {};
	const N = (tag) => {
		if (!namesCache[tag]) {
			if (!global.__graak_intl_names?.[tag]) loadScript(`intl-names-${tag}.js`);
			namesCache[tag] = global.__graak_intl_names[tag];
		}
		return namesCache[tag];
	};

	// ---- language tags ------------------------------------------------------------------------------------------------
	const LANGUAGE_ALIASES = { iw: "he", in: "id", ji: "yi", jw: "jv", mo: "ro", tl: "fil", sh: "sr-Latn", cmn: "zh", scc: "sr", scr: "hr", ars: "ar", adp: "dz", tw: "ak" };
	const REGION_ALIASES = { UK: "GB", BU: "MM", DD: "DE", FX: "FR", TP: "TL", YD: "YE", ZR: "CD", SU: "RU", YU: "RS", CS: "RS" };
	const VARIANT = /^(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3})$/;

	/** A BCP 47 language tag as { language, script, region, variants, unicode: {key: [values]}, unicodeAttrs, other, privateUse }, or null when malformed. */
	function parseTag(input) {
		const parts = String(input).split("-");
		if (parts.some((p) => !/^[A-Za-z0-9]{1,8}$/.test(p))) return null;
		let i = 0;
		if (!/^(?:[A-Za-z]{2,3}|[A-Za-z]{5,8})$/.test(parts[i])) return null;
		const out = { language: parts[i].toLowerCase(), script: undefined, region: undefined, variants: [], unicode: {}, unicodeAttrs: [], other: [], privateUse: "" };
		i++;
		if (/^[A-Za-z]{4}$/.test(parts[i] ?? "")) out.script = parts[i++];
		if (/^(?:[A-Za-z]{2}|\d{3})$/.test(parts[i] ?? "")) out.region = parts[i++];
		while (i < parts.length && VARIANT.test(parts[i])) out.variants.push(parts[i++].toLowerCase());
		if (new Set(out.variants).size !== out.variants.length) return null;
		const seen = new Set();
		while (i < parts.length) {
			if (parts[i].length !== 1) return null;
			const singleton = parts[i++].toLowerCase();
			if (seen.has(singleton)) return null;
			seen.add(singleton);
			if (singleton === "x") {
				if (i >= parts.length) return null;
				out.privateUse = parts.slice(i).join("-").toLowerCase();
				break;
			}
			const values = [];
			while (i < parts.length && parts[i].length > 1) values.push(parts[i++].toLowerCase());
			if (!values.length) return null;
			if (singleton === "u") {
				let key = null;
				for (const v of values) {
					if (v.length === 2 && /^[a-z0-9][a-z]$/.test(v)) {
						key = v;
						out.unicode[key] ??= [];
					} else if (key) out.unicode[key].push(v);
					else out.unicodeAttrs.push(v);
				}
			} else out.other.push([singleton, values.join("-")]);
		}
		return out;
	}
	const titleCase = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
	function serializeTag(t) {
		const parts = [t.language];
		if (t.script) parts.push(titleCase(t.script));
		if (t.region) parts.push(t.region.toUpperCase());
		parts.push(...t.variants);
		const ext = [];
		const keys = Object.keys(t.unicode).sort();
		if (keys.length || t.unicodeAttrs.length) {
			const body = [...t.unicodeAttrs];
			for (const k of keys) body.push(k, ...t.unicode[k].filter((x) => x !== "true"));
			ext.push(["u", body.join("-")]);
		}
		ext.push(...t.other);
		ext.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		for (const [singleton, value] of ext) parts.push(singleton, value);
		if (t.privateUse) parts.push("x", t.privateUse);
		return parts.join("-");
	}
	function canonicalizeTag(input, forConstructor = true) {
		if (typeof input !== "string" && !(input && typeof input === "object")) throw new TypeError("Incorrect locale information provided");
		if (input instanceof IntlObject.Locale) return input.toString();
		const text = String(input);
		const t = parseTag(text);
		if (!t) throw new RangeError(forConstructor ? "Incorrect locale information provided" : `Invalid language tag: ${text}`);
		const alias = LANGUAGE_ALIASES[t.language];
		if (alias) {
			const [language, script] = alias.split("-");
			t.language = language;
			if (script && !t.script) t.script = script;
		}
		if (t.region && REGION_ALIASES[t.region.toUpperCase()]) t.region = REGION_ALIASES[t.region.toUpperCase()];
		return serializeTag(t);
	}
	function canonicalList(locales, forConstructor = true) {
		if (locales === undefined) return [];
		if (locales === null) throw new TypeError("Cannot convert undefined or null to object");
		if (typeof locales === "string" || locales instanceof IntlObject.Locale) return [canonicalizeTag(locales, forConstructor)];
		const list = [];
		for (const item of Array.from(Object(locales))) {
			const tag = canonicalizeTag(item, forConstructor);
			if (!list.includes(tag)) list.push(tag);
		}
		return list;
	}

	/** The data tag whose conventions a locale uses, or null when its language has none. */
	function dataTagFor(t) {
		const tags = D().tags;
		const region = t.region?.toUpperCase();
		if (region && tags.includes(`${t.language}-${region}`)) return `${t.language}-${region}`;
		if (!DEFAULT_REGION[t.language]) return null;
		if (t.language === "zh") return t.script === "Hant" || ["TW", "HK", "MO"].includes(region) ? (region === "HK" || region === "MO" ? "zh-HK" : "zh-TW") : "zh-CN";
		if (t.language === "en") return region && ["NZ", "IE", "ZA", "SG", "HK", "MY", "PK", "NG", "KE", "IN"].includes(region) ? (region === "IN" ? "en-IN" : "en-GB") : "en-US";
		if (t.language === "es") return region && !["ES", "GQ"].includes(region) ? "es-419" : "es-ES";
		if (t.language === "pt") return region && !["BR"].includes(region) ? "pt-PT" : "pt-BR";
		if (t.language === "de") return "de-DE";
		if (t.language === "fr") return "fr-FR";
		return `${t.language}-${DEFAULT_REGION[t.language]}`;
	}
	const COLLATOR_REGIONS = ["en-US", "de-AT", "fr-CA", "zh-CN", "zh-TW", "zh-HK", "zh-MO", "zh-SG", "sr-ME", "sr-RS", "sr-BA", "pa-PK", "ha-NE", "ha-GH"];
	const RELEVANT_KEYS = { NumberFormat: ["nu"], DateTimeFormat: ["ca", "hc", "nu"], Collator: ["co", "kn", "kf"] };
	const SUPPORTED_KEY_VALUES = { nu: ["latn"], ca: ["gregory"], hc: ["h11", "h12", "h23", "h24"], co: ["standard", "search"], kn: ["true", "false"], kf: ["upper", "lower", "false"] };
	/** { dataTag, locale, language, keys } for the requested locales; the reported locale keeps only the extension keys the service honours. */
	function resolveLocale(locales, service, options = {}) {
		for (const tag of canonicalList(locales)) {
			const t = parseTag(tag);
			const dataTag = dataTagFor(t);
			if (!dataTag) continue;
			const keys = {};
			const own = { ...t, unicode: {}, unicodeAttrs: [], other: [], privateUse: "" };
			for (const key of RELEVANT_KEYS[service] ?? []) {
				const ext = t.unicode[key];
				const fromOption = options[key === "hc" ? "hourCycle" : key === "kn" ? "numeric" : key === "kf" ? "caseFirst" : key === "co" ? "collation" : key === "ca" ? "calendar" : "numberingSystem"];
				let value = ext === undefined ? undefined : ext.join("-") || "true";
				const accepted = value !== undefined && (SUPPORTED_KEY_VALUES[key] ?? []).includes(value);
				if (accepted) {
					keys[key] = value;
					if (fromOption === undefined || String(fromOption) === value) own.unicode[key] = value === "true" ? [] : [value];
				}
			}
			let locale = serializeTag(own);
			if (service === "PluralRules") locale = t.language === "pt" && t.region === "PT" ? "pt-PT" : t.language;
			else if (service === "Collator" && !COLLATOR_REGIONS.includes(`${t.language}-${t.region}`)) locale = serializeTag({ ...own, region: undefined });
			return { dataTag, locale, language: t.language, keys };
		}
		const fallback = parseTag(canonicalizeTag(envLocale()));
		const dataTag = dataTagFor(fallback) ?? "en-US";
		return { dataTag, locale: dataTagFor(fallback) ? serializeTag({ ...fallback, unicode: {}, unicodeAttrs: [], other: [], privateUse: "" }) : "en-US", language: dataTag.split("-")[0], keys: {} };
	}
	const supportedLocalesOf = (locales, options) => {
		if (options !== undefined) {
			const matcher = coerceOptions(options).localeMatcher;
			if (matcher !== undefined && !["lookup", "best fit"].includes(String(matcher))) throw new RangeError(`Value ${matcher} out of range for Intl options property localeMatcher`);
		}
		return canonicalList(locales).filter((tag) => dataTagFor(parseTag(tag)) !== null);
	};

	// ---- option helpers --------------------------------------------------------------------------------------------------
	const getOption = (options, name, type, values, fallback, service) => {
		let value = options[name];
		if (value === undefined) return fallback;
		if (type === "boolean") value = Boolean(value);
		else if (type === "string") value = String(value);
		if (values && !values.includes(value)) throw new RangeError(`Value ${value} out of range for ${service} options property ${name}`);
		return value;
	};
	const getNumberOption = (options, name, min, max, fallback) => {
		const v = options[name];
		if (v === undefined) return fallback;
		const n = Number(v);
		if (Number.isNaN(n) || n < min || n > max) throw new RangeError(`${name} value is out of range.`);
		return Math.floor(n);
	};
	function coerceOptions(options) {
		if (options === undefined) return Object.create(null);
		if (options === null) throw new TypeError("Cannot convert undefined or null to object");
		return Object(options);
	}
	const SERVICE = "Intl.NumberFormat";

	// ---- decimals -----------------------------------------------------------------------------------------------------------
	/** A number as { neg, digits, exp }: value = 0.digits × 10^exp, digits without leading or trailing zeros ("" for zero). */
	function toDecimal(value) {
		if (typeof value === "bigint") {
			const neg = value < 0n;
			const text = (neg ? -value : value).toString();
			const trimmed = text.replace(/0+$/, "");
			return trimmed === "0" ? { neg, digits: "", exp: 0 } : { neg, digits: trimmed, exp: text.length };
		}
		if (typeof value === "string") {
			const m = /^\s*([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\s*$/.exec(value);
			if (m) {
				const intPart = m[2] ?? "";
				const frac = m[3] ?? m[4] ?? "";
				const all = intPart + frac;
				const lead = all.length - all.replace(/^0+/, "").length;
				const digits = all.replace(/^0+/, "").replace(/0+$/, "");
				return { neg: m[1] === "-", digits, exp: digits ? intPart.length - lead + Number(m[5] ?? 0) : 0 };
			}
			return toDecimal(Number(value));
		}
		const n = Number(value);
		const neg = n < 0 || Object.is(n, -0);
		const a = Math.abs(n);
		if (a === 0) return { neg, digits: "", exp: 0 };
		const [mantissa, e] = a.toExponential().split("e");
		return { neg, digits: mantissa.replace(".", "").replace(/0+$/, ""), exp: Number(e) + 1 };
	}
	/**
	 * Rounds to a multiple of `increment` units in the `position`-th place after the decimal point (negative: before it) by a
	 * rounding mode, in exact integer arithmetic.
	 */
	function roundDecimal(dec, position, mode = "halfExpand", increment = 1) {
		if (!dec.digits) return dec;
		const digits = BigInt(dec.digits);
		const k = dec.exp - dec.digits.length + position; // value × 10^position = digits × 10^k
		let quotient;
		let remainder = 0n;
		let divisor = 1n;
		if (k >= 0) quotient = digits * 10n ** BigInt(k);
		else {
			divisor = 10n ** BigInt(-k);
			quotient = digits / divisor;
			remainder = digits % divisor;
		}
		const inc = BigInt(increment);
		const lower = (quotient / inc) * inc;
		const above = (quotient - lower) * divisor + remainder;
		if (above === 0n) return dec;
		const twice = above * 2n;
		const total = inc * divisor;
		const half = twice === total;
		const past = twice > total;
		const neg = dec.neg;
		let up;
		switch (mode) {
			case "ceil": up = !neg; break;
			case "floor": up = neg; break;
			case "expand": up = true; break;
			case "trunc": up = false; break;
			case "halfCeil": up = past || (half && !neg); break;
			case "halfFloor": up = past || (half && neg); break;
			case "halfTrunc": up = past; break;
			case "halfEven": up = past || (half && (lower / inc) % 2n === 1n); break;
			default: up = past || half;
		}
		const rounded = up ? lower + inc : lower;
		if (rounded === 0n) return { neg, digits: "", exp: 0 };
		const text = rounded.toString();
		return { neg, digits: text.replace(/0+$/, ""), exp: text.length - position };
	}
	/** The integer and fraction digit strings of a decimal. */
	function splitDecimal(dec, minInt, minFraction, maxFraction) {
		let integer;
		let fraction;
		if (!dec.digits) {
			integer = "0";
			fraction = "";
		} else if (dec.exp <= 0) {
			integer = "0";
			fraction = "0".repeat(-dec.exp) + dec.digits;
		} else if (dec.exp >= dec.digits.length) {
			integer = dec.digits + "0".repeat(dec.exp - dec.digits.length);
			fraction = "";
		} else {
			integer = dec.digits.slice(0, dec.exp);
			fraction = dec.digits.slice(dec.exp);
		}
		if (fraction.length > maxFraction) fraction = fraction.slice(0, maxFraction);
		fraction = fraction.replace(/0+$/, "");
		if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
		return { integer: integer.padStart(minInt, "0"), fraction };
	}

	// ---- plural rules (CLDR) ---------------------------------------------------------------------------------------------------
	const operands = (text) => {
		const [i = "0", f = ""] = String(text).split(".");
		return { n: Number(text), i: Number(i), v: f.length };
	};
	const within = (x, ...ranges) => ranges.some((r) => (Array.isArray(r) ? x >= r[0] && x <= r[1] : x === r));
	const millions = (o) => o.i !== 0 && o.i % 1000000 === 0 && o.v === 0;
	const CARDINAL = {
		en: (o) => (o.i === 1 && o.v === 0 ? "one" : "other"),
		de: (o) => (o.i === 1 && o.v === 0 ? "one" : "other"),
		nl: (o) => (o.i === 1 && o.v === 0 ? "one" : "other"),
		sv: (o) => (o.i === 1 && o.v === 0 ? "one" : "other"),
		it: (o) => (o.i === 1 && o.v === 0 ? "one" : millions(o) ? "many" : "other"),
		es: (o) => (o.n === 1 ? "one" : millions(o) ? "many" : "other"),
		fr: (o) => (o.i === 0 || o.i === 1 ? "one" : millions(o) ? "many" : "other"),
		pt: (o) => (o.i === 0 || o.i === 1 ? "one" : millions(o) ? "many" : "other"),
		"pt-PT": (o) => (o.i === 1 && o.v === 0 ? "one" : millions(o) ? "many" : "other"),
		tr: (o) => (o.n === 1 ? "one" : "other"),
		pl: (o) => (o.i === 1 && o.v === 0 ? "one" : o.v === 0 && within(o.i % 10, [2, 4]) && !within(o.i % 100, [12, 14]) ? "few" : o.v === 0 && ((o.i !== 1 && within(o.i % 10, 0, 1)) || within(o.i % 10, [5, 9]) || within(o.i % 100, [12, 14])) ? "many" : "other"),
		ru: (o) => (o.v === 0 && o.i % 10 === 1 && o.i % 100 !== 11 ? "one" : o.v === 0 && within(o.i % 10, [2, 4]) && !within(o.i % 100, [12, 14]) ? "few" : o.v === 0 && (o.i % 10 === 0 || within(o.i % 10, [5, 9]) || within(o.i % 100, [11, 14])) ? "many" : "other"),
	};
	const ORDINAL = {
		en: (o) => {
			const n10 = o.n % 10;
			const n100 = o.n % 100;
			if (n10 === 1 && n100 !== 11) return "one";
			if (n10 === 2 && n100 !== 12) return "two";
			if (n10 === 3 && n100 !== 13) return "few";
			return "other";
		},
		sv: (o) => ((o.n % 10 === 1 || o.n % 10 === 2) && o.n % 100 !== 11 && o.n % 100 !== 12 ? "one" : "other"),
		it: (o) => (within(o.n, 11, 8, 80, 800) ? "many" : "other"),
		fr: (o) => (o.n === 1 ? "one" : "other"),
	};
	/** The plural category of a formatted number (digits with an optional ".fraction") in a locale, by its data tag. */
	function pluralCategory(tag, type, text) {
		const table = type === "ordinal" ? ORDINAL : CARDINAL;
		const rule = table[tag] ?? table[tag.split("-")[0]];
		return rule ? rule(operands(text)) : "other";
	}

	// ---- NumberFormat ------------------------------------------------------------------------------------------------------------
	function groupInteger(integer, sizes, minGrouping, useGrouping) {
		if (useGrouping === false) return [integer];
		const [primary, secondary] = sizes;
		const min = useGrouping === "min2" ? 2 : useGrouping === "always" ? 1 : minGrouping;
		if (integer.length < primary + min) return [integer];
		const groups = [integer.slice(-primary)];
		let rest = integer.slice(0, -primary);
		while (rest.length > secondary) {
			groups.unshift(rest.slice(-secondary));
			rest = rest.slice(0, -secondary);
		}
		if (rest) groups.unshift(rest);
		return groups;
	}
	const SANCTIONED_UNITS = new Set(["acre", "bit", "byte", "celsius", "centimeter", "day", "degree", "fahrenheit", "fluid-ounce", "foot", "gallon", "gigabit", "gigabyte", "gram", "hectare", "hour", "inch", "kilobit", "kilobyte", "kilogram", "kilometer", "liter", "megabit", "megabyte", "meter", "microsecond", "mile", "mile-scandinavian", "milliliter", "millimeter", "millisecond", "minute", "month", "nanosecond", "ounce", "percent", "petabyte", "pound", "second", "stone", "terabit", "terabyte", "week", "yard", "year"]);
	function validUnit(unit) {
		if (SANCTIONED_UNITS.has(unit)) return true;
		const m = /^(.+)-per-(.+)$/.exec(unit);
		return Boolean(m && SANCTIONED_UNITS.has(m[1]) && SANCTIONED_UNITS.has(m[2]));
	}
	/** Fills a pattern's {x} placeholders with parts (or arrays of parts); the text between them becomes literal parts. */
	function fill(template, replacements) {
		const out = [];
		let literal = "";
		for (const chunk of template.split(/(\{[a-z%+-]\})/)) {
			const m = /^\{([a-z%+-])\}$/.exec(chunk);
			if (!m) {
				literal += chunk;
				continue;
			}
			const r = replacements[m[1]];
			if (r === undefined || r === null) continue;
			if (literal) out.push({ type: "literal", value: literal });
			literal = "";
			if (Array.isArray(r)) out.push(...r);
			else out.push(r);
		}
		if (literal) out.push({ type: "literal", value: literal });
		return out;
	}
	/** Splits literal parts into whitespace (literal) and words (`type`). */
	function retype(parts, type) {
		const out = [];
		for (const part of parts) {
			if (part.type !== "literal") {
				out.push(part);
				continue;
			}
			const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.value);
			if (m[1]) out.push({ type: "literal", value: m[1] });
			if (m[2]) out.push({ type, value: m[2] });
			if (m[3]) out.push({ type: "literal", value: m[3] });
		}
		return out;
	}
	const FRACTION_ROUNDING_INCREMENTS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

	class NumberFormat {
		#r;
		#data;
		#tag;
		#locale;
		constructor(locales, options) {
			options = coerceOptions(options);
			const resolved = resolveLocale(locales, "NumberFormat", options);
			getOption(options, "localeMatcher", "string", ["lookup", "best fit"], "best fit", SERVICE);
			const nu = getOption(options, "numberingSystem", "string", undefined, undefined, SERVICE);
			if (nu !== undefined && !/^[A-Za-z0-9]{3,8}(-[A-Za-z0-9]{3,8})*$/.test(nu)) throw new RangeError(`Invalid numberingSystem : ${nu}`);
			const style = getOption(options, "style", "string", ["decimal", "percent", "currency", "unit"], "decimal", SERVICE);
			let currency = getOption(options, "currency", "string", undefined, undefined, SERVICE);
			if (currency !== undefined && !/^[A-Za-z]{3}$/.test(currency)) throw new RangeError(`Invalid currency code : ${currency}`);
			if (style === "currency" && currency === undefined) throw new TypeError("Currency code is required with currency style.");
			currency = currency?.toUpperCase();
			const currencyDisplay = getOption(options, "currencyDisplay", "string", ["code", "symbol", "narrowSymbol", "name"], "symbol", SERVICE);
			const currencySign = getOption(options, "currencySign", "string", ["standard", "accounting"], "standard", SERVICE);
			const unit = getOption(options, "unit", "string", undefined, undefined, SERVICE);
			if (unit !== undefined && !validUnit(unit)) throw new RangeError(`Invalid unit argument for Intl.NumberFormat() '${unit}'`);
			if (style === "unit" && unit === undefined) throw new TypeError("Unit is required with unit style.");
			const unitDisplay = getOption(options, "unitDisplay", "string", ["short", "narrow", "long"], "short", SERVICE);
			const notation = getOption(options, "notation", "string", ["standard", "scientific", "engineering", "compact"], "standard", SERVICE);
			const compactDisplay = getOption(options, "compactDisplay", "string", ["short", "long"], "short", SERVICE);
			const signDisplay = getOption(options, "signDisplay", "string", ["auto", "never", "always", "exceptZero", "negative"], "auto", SERVICE);
			const roundingMode = getOption(options, "roundingMode", "string", ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"], "halfExpand", SERVICE);
			const roundingPriority = getOption(options, "roundingPriority", "string", ["auto", "morePrecision", "lessPrecision"], "auto", SERVICE);
			const trailingZeroDisplay = getOption(options, "trailingZeroDisplay", "string", ["auto", "stripIfInteger"], "auto", SERVICE);
			const roundingIncrement = getNumberOption(options, "roundingIncrement", 1, 5000, 1);
			if (!FRACTION_ROUNDING_INCREMENTS.includes(roundingIncrement)) throw new RangeError("roundingIncrement value is out of range.");
			let useGrouping = options.useGrouping;
			const defaultGrouping = notation === "compact" ? "min2" : "auto";
			if (useGrouping === undefined) useGrouping = defaultGrouping;
			else if (useGrouping === true || useGrouping === "true") useGrouping = "always";
			else if (useGrouping === false || useGrouping === "false" || useGrouping === 0 || useGrouping === "" || useGrouping === null) useGrouping = false;
			else if (!["min2", "auto", "always"].includes(useGrouping)) {
				if (typeof useGrouping === "string") throw new RangeError(`Value ${useGrouping} out of range for ${SERVICE} options property useGrouping`);
				useGrouping = defaultGrouping;
			}
			const minimumIntegerDigits = getNumberOption(options, "minimumIntegerDigits", 1, 21, 1);
			const currencyDigits = style === "currency" ? (D().currencyDigits[currency] ?? 2) : 0;
			const mnfdDefault = style === "currency" && notation === "standard" ? currencyDigits : 0;
			const mxfdDefault = style === "currency" && notation === "standard" ? currencyDigits : style === "percent" ? 0 : 3;
			const hasSD = options.minimumSignificantDigits !== undefined || options.maximumSignificantDigits !== undefined;
			const hasFD = options.minimumFractionDigits !== undefined || options.maximumFractionDigits !== undefined;
			let needSD = true;
			let needFD = true;
			if (roundingPriority === "auto") {
				needSD = hasSD;
				if (needSD || (!hasFD && notation === "compact")) needFD = false;
			}
			const r = { minimumIntegerDigits };
			if (needSD) {
				r.minimumSignificantDigits = hasSD ? getNumberOption(options, "minimumSignificantDigits", 1, 21, 1) : 1;
				r.maximumSignificantDigits = hasSD ? getNumberOption(options, "maximumSignificantDigits", r.minimumSignificantDigits, 21, 21) : 21;
			}
			if (needFD) {
				let mnfd = options.minimumFractionDigits;
				let mxfd = options.maximumFractionDigits;
				if (mnfd !== undefined) mnfd = getNumberOption(options, "minimumFractionDigits", 0, 100, undefined);
				if (mxfd !== undefined) mxfd = getNumberOption(options, "maximumFractionDigits", 0, 100, undefined);
				if (mnfd === undefined) mnfd = Math.min(mnfdDefault, mxfd ?? mnfdDefault);
				else if (mxfd === undefined) mxfd = Math.max(mxfdDefault, mnfd);
				else if (mnfd > mxfd) throw new RangeError("maximumFractionDigits value is out of range.");
				r.minimumFractionDigits = mnfd;
				r.maximumFractionDigits = mxfd ?? Math.max(mxfdDefault, mnfd);
			}
			const compactRounding = notation === "compact" && !needSD && !needFD;
			if (roundingIncrement !== 1) {
				if (needSD || compactRounding) throw new TypeError("RoundingType is not fractionDigits");
				if (r.minimumFractionDigits !== r.maximumFractionDigits) throw new RangeError("maximumFractionDigits value is out of range.");
			}
			this.#r = { ...r, style, currency, currencyDisplay, currencySign, unit, unitDisplay, notation, compactDisplay, signDisplay, roundingMode, roundingIncrement, roundingPriority: compactRounding ? "morePrecision" : needSD && needFD ? roundingPriority : "auto", trailingZeroDisplay, useGrouping, compactRounding, needSD, needFD };
			this.#tag = resolved.dataTag;
			this.#locale = resolved.locale;
			this.#data = L(resolved.dataTag).number;
			Object.defineProperty(this, "format", { value: (value) => this.formatToParts(value).map((p) => p.value).join(""), configurable: true, writable: true });
		}

		/** Rounds a decimal as configured; also returns the digit counts to pad to. */
		#round(dec) {
			const r = this.#r;
			if (r.compactRounding) {
				// Compact rounding: an integer when two or more digits show before the point, else two significant digits.
				const rounded = Math.max(dec.exp, 1) >= 2 ? roundDecimal(dec, 0, r.roundingMode) : roundDecimal(dec, 2 - dec.exp, r.roundingMode);
				return { dec: rounded, minFraction: 0, maxFraction: 21 };
			}
			const bySignificant = () => ({ dec: dec.digits ? roundDecimal(dec, r.maximumSignificantDigits - dec.exp, r.roundingMode) : dec, minSig: r.minimumSignificantDigits });
			const byFraction = () => ({ dec: roundDecimal(dec, r.maximumFractionDigits, r.roundingMode, r.roundingIncrement), minFraction: r.minimumFractionDigits, maxFraction: r.maximumFractionDigits });
			if (r.needSD && r.needFD) {
				const a = bySignificant();
				const b = byFraction();
				// The rounding that leaves the finer (or coarser) last digit wins: compare the power of ten each keeps.
				const unitSignificant = dec.exp - r.maximumSignificantDigits;
				const unitFraction = -r.maximumFractionDigits;
				const finerBySignificant = unitSignificant <= unitFraction;
				return (r.roundingPriority === "morePrecision" ? finerBySignificant : !finerBySignificant) ? a : b;
			}
			return r.needSD ? bySignificant() : byFraction();
		}

		formatToParts(value) {
			const r = this.#r;
			const data = this.#data;
			const number = typeof value === "bigint" || typeof value === "string" ? value : Number(value);
			const nan = typeof number === "number" && Number.isNaN(number);
			const special = typeof number === "number" && !Number.isFinite(number);
			let dec = special ? { neg: number < 0, digits: "", exp: 0 } : toDecimal(number);
			const negativeInput = !nan && dec.neg;
			if (!special && r.style === "percent" && dec.digits) dec = { ...dec, exp: dec.exp + 2 };

			const originalDec = dec;
			// Compact notation groups from five digits whatever "auto" would say; a compact currency is always the short form.
			const useGrouping = r.notation === "compact" && r.useGrouping === "auto" ? "min2" : r.useGrouping;
			const compactDisplay = r.style === "currency" && r.currencyDisplay !== "name" ? "short" : r.compactDisplay;
			let exponent = null;
			let compactPower = null;
			if (!special && dec.digits && r.notation !== "standard") {
				const magnitude = dec.exp - 1;
				if (r.notation === "scientific" || r.notation === "engineering") {
					exponent = r.notation === "engineering" ? Math.floor(magnitude / 3) * 3 : magnitude;
					dec = { ...dec, exp: dec.exp - exponent };
				} else {
					const table = data.compact[compactDisplay];
					const removedFor = (m) => (m >= 3 ? table.remove[Math.min(m, 21)] : 0);
					let removed = removedFor(magnitude);
					const rounded = this.#round({ ...dec, exp: dec.exp - removed }).dec;
					// Rounding can carry into the next power of ten: 999999 shows as 1M, not 1000K.
					if (rounded.digits && rounded.exp - 1 + removed > magnitude) removed = removedFor(rounded.exp - 1 + removed);
					dec = { ...dec, exp: dec.exp - removed };
					if (removed > 0) compactPower = removed;
				}
			} else if (r.notation === "scientific" || r.notation === "engineering") exponent = 0;

			let integer = "";
			let fraction = "";
			let zero = false;
			if (!special) {
				const res = this.#round(dec);
				dec = res.dec;
				zero = !dec.digits;
				// Rounding the mantissa can carry it to the next exponent: 9.99995E4 shows as 1E5.
				if (exponent !== null && dec.digits) {
					const step = r.notation === "engineering" ? 3 : 1;
					if (dec.exp - 1 >= step) {
						exponent += step;
						dec = { ...dec, exp: dec.exp - step };
					}
				}
				if (res.minSig !== undefined) {
					const sd = splitDecimal(dec, r.minimumIntegerDigits, 0, 100);
					integer = sd.integer;
					fraction = sd.fraction;
					const lead = integer.replace(/^0+/, "");
					const shown = lead.length ? lead.length + fraction.length : fraction.replace(/^0+/, "").length;
					const pad = res.minSig - Math.max(shown, dec.digits ? 0 : 1);
					if (pad > 0) fraction = fraction.padEnd(fraction.length + pad, "0");
				} else {
					const sd = splitDecimal(dec, r.minimumIntegerDigits, res.minFraction, res.maxFraction);
					integer = sd.integer;
					fraction = sd.fraction;
				}
				if (r.trailingZeroDisplay === "stripIfInteger" && /^0*$/.test(fraction)) fraction = "";
			}
			const displayed = special ? "" : fraction ? `${integer}.${fraction}` : integer;

			let sign = "";
			switch (r.signDisplay) {
				case "never": break;
				case "always": sign = negativeInput ? "-" : "+"; break;
				case "exceptZero": sign = zero || nan ? "" : negativeInput ? "-" : "+"; break;
				case "negative": sign = negativeInput && !zero ? "-" : ""; break;
				default: sign = negativeInput ? "-" : "";
			}
			const signPart = sign === "-" ? { type: "minusSign", value: data.minus } : sign === "+" ? { type: "plusSign", value: data.plus } : null;

			// Under compact and scientific notation the plural form follows the whole value, not the digits that are shown.
			const whole = !special && r.notation !== "standard" && originalDec.digits ? splitDecimal(originalDec, 1, 0, 100) : null;
			const shownCategory = () => (special ? "other" : pluralCategory(this.#tag, "cardinal", displayed));
			const category = () => (special ? "other" : whole ? pluralCategory(this.#tag, "cardinal", whole.fraction ? `${whole.integer}.${whole.fraction}` : whole.integer) : shownCategory());
			let body = [];
			if (special) body.push({ type: nan ? "nan" : "infinity", value: nan ? data.nan : data.infinity });
			else {
				const sizes = r.style === "currency" && r.currencySign === "accounting" && data.currency.accountingGroupSizes ? data.currency.accountingGroupSizes : data.groupSizes;
				const groupSymbol = r.style === "currency" ? data.currency.group : data.group;
				const decimalSymbol = r.style === "currency" ? data.currency.decimal : data.decimal;
				groupInteger(integer, sizes, data.minGrouping, useGrouping).forEach((g, i) => {
					if (i) body.push({ type: "group", value: groupSymbol });
					body.push({ type: "integer", value: g });
				});
				if (fraction) body.push({ type: "decimal", value: decimalSymbol }, { type: "fraction", value: fraction });
				if (exponent !== null) {
					body.push({ type: "exponentSeparator", value: data.exp });
					if (exponent < 0) body.push({ type: "exponentMinusSign", value: data.minus });
					body.push({ type: "exponentInteger", value: String(Math.abs(exponent)) });
				}
				if (compactPower !== null) {
					const forms = data.compact[compactDisplay].forms[compactPower];
					const template = (displayed === "1" && forms["=1"] !== undefined ? forms["=1"] : forms[shownCategory()]) ?? forms.other;
					body = retype(fill(template, { n: body }), "compact");
				}
			}

			const put = (template, extra, signInTemplate = false) => {
				const out = fill(template, { n: body, "-": signPart, "+": signPart, ...extra });
				if (signPart && !signInTemplate && !template.includes("{-}") && !template.includes("{+}")) {
					// The sign belongs right before the number, wherever the pattern puts it ("每小時 +12 公里").
					const at = out.findIndex((part) => part === body[0]);
					out.splice(at < 0 ? 0 : at, 0, signPart);
				}
				return out;
			};
			if (r.style === "percent") {
				const compactNotation = r.notation === "compact";
				const parts = put(sign ? (compactNotation ? data.percentCompactNeg : data.percentNeg) : compactNotation ? data.percentCompact : data.percent, { "%": { type: "percentSign", value: data.percentSign } });
				// After a compact number ICU reports the percent sign as a unit.
				return compactNotation ? retype(parts, "unit") : parts;
			}
			if (r.style === "currency") {
				const symbols = data.symbols[r.currency];
				const wholeNumber = !fraction && !special;
				const shownName = r.currencyDisplay === "name" ? ((wholeNumber ? symbols?.w0?.[category()] : undefined) ?? symbols?.c[category()] ?? symbols?.c.other ?? r.currency) : null;
				const text = r.currencyDisplay === "code" ? r.currency : shownName ?? (r.currencyDisplay === "narrowSymbol" ? symbols?.w : symbols?.s) ?? r.currency;
				const accounting = r.currencySign === "accounting" && r.currencyDisplay !== "name" && sign !== "";
				const compactCurrency = compactPower !== null && r.currencyDisplay !== "name";
				const set = compactCurrency ? data.currency.compact[r.currencyDisplay] : data.currency[r.currencyDisplay];
				const accountingSet = compactCurrency ? set : data.currency;
				const template = accounting ? (sign === "-" ? accountingSet.accounting : accountingSet.accountingPlus) : sign === "-" ? set.neg : sign === "+" ? set.plus : set.pos;
				// An accounting negative may show its sign as parentheses, which its pattern carries itself.
				const out = put(template, { c: { type: "currency", value: text }, s: { type: "currency", value: symbols?.s ?? r.currency } }, accounting && sign === "-" && /[()]/.test(template));
				// CLDR's currency spacing: where a letter meets the digits, a no-break space goes between.
				const digitPart = (p) => p && p.type === "integer";
				const letterEdge = (ch) => ch !== undefined && !/\p{S}/u.test(ch);
				for (let i = 0; i < out.length && r.currencyDisplay !== "name"; i++) {
					if (out[i].type !== "currency") continue;
					const chars = [...out[i].value];
					if (digitPart(out[i + 1]) && letterEdge(chars[chars.length - 1])) out.splice(i + 1, 0, { type: "literal", value: " " });
					else if (digitPart(out[i - 1]) && letterEdge(chars[0])) out.splice(i, 0, { type: "literal", value: " " });
				}
				return out;
			}
			if (r.style === "unit") {
				const entry = data.units[r.unit] ?? this.#composeUnit(r.unit);
				const forms = entry[r.unitDisplay];
				return retype(put(forms[category()] ?? forms.other, {}), "unit");
			}
			return signPart ? [signPart, ...body] : body;
		}
		#composeUnit(unit) {
			const m = /^(.+)-per-(.+)$/.exec(unit);
			const units = this.#data.units;
			if (!m || !units[m[1]] || !units[m[2]]) throw new RangeError(`Invalid unit argument for Intl.NumberFormat() '${unit}'`);
			const out = {};
			for (const style of ["short", "long", "narrow"]) {
				out[style] = {};
				const denominator = (units[m[2]][style].one ?? units[m[2]][style].other).replace("{n}", "").trim();
				for (const cat of Object.keys(units[m[1]][style])) out[style][cat] = style === "long" ? `${units[m[1]][style][cat]} per ${denominator}` : `${units[m[1]][style][cat]}/${denominator}`;
			}
			return out;
		}
		formatRange(start, end) {
			return this.formatRangeToParts(start, end).map((p) => p.value).join("");
		}
		formatRangeToParts(start, end) {
			if (start === undefined || end === undefined) throw new TypeError("start or end is undefined");
			const a = this.formatToParts(start);
			const b = this.formatToParts(end);
			if (a.map((p) => p.value).join("") === b.map((p) => p.value).join("")) return [{ type: "approximatelySign", value: "~", source: "shared" }, ...a.map((p) => ({ ...p, source: "shared" }))];
			return [...a.map((p) => ({ ...p, source: "startRange" })), { type: "literal", value: this.#data.rangeSep[this.#r.style], source: "shared" }, ...b.map((p) => ({ ...p, source: "endRange" }))];
		}
		resolvedOptions() {
			const r = this.#r;
			const out = { locale: this.#locale, numberingSystem: "latn", style: r.style };
			if (r.style === "currency") Object.assign(out, { currency: r.currency, currencyDisplay: r.currencyDisplay, currencySign: r.currencySign });
			if (r.style === "unit") Object.assign(out, { unit: r.unit, unitDisplay: r.unitDisplay });
			out.minimumIntegerDigits = r.minimumIntegerDigits;
			if (r.compactRounding) Object.assign(out, { minimumFractionDigits: 0, maximumFractionDigits: 0, minimumSignificantDigits: 1, maximumSignificantDigits: 2 });
			else {
				if (r.minimumFractionDigits !== undefined) Object.assign(out, { minimumFractionDigits: r.minimumFractionDigits, maximumFractionDigits: r.maximumFractionDigits });
				if (r.minimumSignificantDigits !== undefined) Object.assign(out, { minimumSignificantDigits: r.minimumSignificantDigits, maximumSignificantDigits: r.maximumSignificantDigits });
			}
			out.useGrouping = r.useGrouping;
			out.notation = r.notation;
			if (r.notation === "compact") out.compactDisplay = r.compactDisplay;
			out.signDisplay = r.signDisplay;
			out.roundingIncrement = r.roundingIncrement;
			out.roundingMode = r.roundingMode;
			out.roundingPriority = r.roundingPriority;
			out.trailingZeroDisplay = r.trailingZeroDisplay;
			return out;
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.NumberFormat";
		}
	}

	// ---- time zones -------------------------------------------------------------------------------------------------------------------------
	const zoneRecords = new Map();
	let zoneIndex = null;
	function zoneRecord(canonical) {
		let record = zoneRecords.get(canonical);
		if (!record) {
			const raw = D().zones[canonical];
			const at = [];
			let last = 0;
			if (raw.t) for (const t of raw.t.split(",")) at.push((last += Number.parseInt(t, 36)));
			record = { initial: raw.i, at, offsets: raw.o ? raw.o.split(",").map((v) => Number.parseInt(v, 36)) : [], dsts: raw.d ? [...raw.d].map(Number) : [], rule: raw.r, ruleFrom: raw.f, names: raw.m ?? [] };
			zoneRecords.set(canonical, record);
		}
		return record;
	}
	/** The canonical IANA name of a zone as the caller wrote it (any case, any alias), or null. */
	function canonicalZone(name) {
		const data = D();
		zoneIndex ??= new Map([...Object.keys(data.zones), ...Object.keys(data.links)].map((n) => [n.toLowerCase(), data.links[n] ?? n]));
		return zoneIndex.get(String(name).toLowerCase()) ?? null;
	}
	const zoneCache = new Map();
	/** { name, canonical } or { name, fixed } for a `timeZone` option; the host's own zone when undefined. */
	function getZone(input) {
		if (input === undefined) {
			const named = envTimeZone();
			if (named && canonicalZone(named)) return getZone(named);
			return (localZone ??= guessLocalZone());
		}
		const key = String(input);
		let zone = zoneCache.get(key);
		if (zone) return zone;
		const offset = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(key);
		if (offset) {
			if (Number(offset[2]) > 23 || Number(offset[3] ?? 0) > 59) throw new RangeError(`Invalid time zone specified: ${key}`);
			zone = { fixed: (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3] ?? 0) * 60), name: `${offset[1]}${offset[2]}:${offset[3] ?? "00"}` };
		} else {
			const canonical = canonicalZone(key);
			if (!canonical) throw new RangeError(`Invalid time zone specified: ${key}`);
			zone = { canonical, name: canonical };
		}
		zoneCache.set(key, zone);
		return zone;
	}
	let localZone = null;
	/** The host's zone when it names none we know: the first zone that has the offsets the host's own clock has. */
	function guessLocalZone() {
		const samples = [];
		for (let year = 1990; year <= 2030; year += 4) samples.push(Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12));
		const wanted = samples.map((ms) => -new Date(ms).getTimezoneOffset() * 60);
		const zoneFor = (name) => ({ canonical: name, name });
		if (wanted.every((o) => o === 0)) return getZone("UTC");
		for (const name of Object.keys(D().zones)) {
			const record = zoneRecord(name);
			if (samples.every((ms, i) => zoneStateAt(record, ms).offset === wanted[i])) return zoneFor(name);
		}
		return getZone("UTC");
	}
	const stateAt = (zone, ms) => (zone.fixed !== undefined ? { offset: zone.fixed, dst: false } : zoneStateAt(zoneRecord(zone.canonical), ms));

	// ---- DateTimeFormat ---------------------------------------------------------------------------------------------------------------------
	const TYPE_NAMES = { y: "year", M: "month", d: "day", E: "weekday", h: "hour", m: "minute", s: "second", a: "dayPeriod", G: "era", z: "timeZoneName", S: "fractionalSecond" };
	const STYLE_NAMES = { n: "numeric", D: "2-digit", L: "long", S: "short", N: "narrow", l: "long-standalone", t: "short-standalone", a: "narrow-standalone", F: "long-format", f: "short-format", g: "narrow-format", X: "flex-long", Y: "flex-short", Z: "flex-narrow", o: "shortOffset", O: "longOffset", p: "shortGeneric", q: "longGeneric", 1: "1", 2: "2", 3: "3", "-": null };
	/** A stored pattern as tokens: text, and [type, style] for each field. */
	function decodePattern(locale, index) {
		let tokens = locale.decoded.get(index);
		if (!tokens) {
			tokens = [];
			const chunks = locale.date.table[index].split("");
			if (chunks[0]) tokens.push(chunks[0]);
			for (const chunk of chunks.slice(1)) {
				tokens.push([TYPE_NAMES[chunk[0]], STYLE_NAMES[chunk[1]]]);
				if (chunk.length > 2) tokens.push(chunk.slice(2));
			}
			locale.decoded.set(index, tokens);
		}
		return tokens;
	}
	const DTF = "Intl.DateTimeFormat";

	class DateTimeFormat {
		#o;
		#locale;
		#zone;
		#hourCycle;
		#tokens;
		constructor(locales, options, defaults = { required: "any", defaults: "date" }) {
			options = coerceOptions(options);
			const resolved = resolveLocale(locales, "DateTimeFormat", options);
			getOption(options, "localeMatcher", "string", ["lookup", "best fit"], "best fit", DTF);
			for (const name of ["calendar", "numberingSystem"]) {
				const v = getOption(options, name, "string", undefined, undefined, DTF);
				if (v !== undefined && !/^[A-Za-z0-9]{3,8}(-[A-Za-z0-9]{3,8})*$/.test(v)) throw new RangeError(`Invalid ${name} : ${v}`);
			}
			const hour12 = getOption(options, "hour12", "boolean", undefined, undefined, DTF);
			let hourCycle = getOption(options, "hourCycle", "string", ["h11", "h12", "h23", "h24"], resolved.keys.hc, DTF);
			if (hour12 !== undefined) hourCycle = undefined;
			if (options.timeZone === null) throw new RangeError("Invalid time zone specified: null");
			const zone = getZone(options.timeZone === undefined ? undefined : String(options.timeZone));
			const o = {};
			const CHOICES = { weekday: ["narrow", "short", "long"], era: ["narrow", "short", "long"], year: ["2-digit", "numeric"], month: ["2-digit", "numeric", "narrow", "short", "long"], day: ["2-digit", "numeric"], dayPeriod: ["narrow", "short", "long"], hour: ["2-digit", "numeric"], minute: ["2-digit", "numeric"], second: ["2-digit", "numeric"] };
			for (const name of Object.keys(CHOICES)) {
				const v = getOption(options, name, "string", CHOICES[name], undefined, DTF);
				if (v !== undefined) o[name] = v;
			}
			const fsd = getNumberOption(options, "fractionalSecondDigits", 1, 3, undefined);
			if (fsd !== undefined) o.fractionalSecondDigits = fsd;
			const tzName = getOption(options, "timeZoneName", "string", ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"], undefined, DTF);
			if (tzName !== undefined) o.timeZoneName = tzName;
			getOption(options, "formatMatcher", "string", ["basic", "best fit"], "best fit", DTF);
			const dateStyle = getOption(options, "dateStyle", "string", ["full", "long", "medium", "short"], undefined, DTF);
			const timeStyle = getOption(options, "timeStyle", "string", ["full", "long", "medium", "short"], undefined, DTF);
			if (dateStyle !== undefined || timeStyle !== undefined) {
				const explicit = Object.keys(o);
				if (explicit.length) throw new TypeError("Invalid option : option");
				if (defaults.required === "date" && timeStyle !== undefined) throw new TypeError("Invalid option : timeStyle");
				if (defaults.required === "time" && dateStyle !== undefined) throw new TypeError("Invalid option : dateStyle");
				if (dateStyle) o.dateStyle = dateStyle;
				if (timeStyle) o.timeStyle = timeStyle;
			} else {
				const hasDate = ["weekday", "year", "month", "day"].some((n) => o[n] !== undefined);
				const hasTime = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"].some((n) => o[n] !== undefined);
				const need = defaults.required === "date" ? !hasDate : defaults.required === "time" ? !hasTime : !hasDate && !hasTime;
				if (need && (defaults.defaults === "date" || defaults.defaults === "all")) Object.assign(o, { year: "numeric", month: "numeric", day: "numeric" });
				if (need && (defaults.defaults === "time" || defaults.defaults === "all")) Object.assign(o, { hour: "numeric", minute: "numeric", second: "numeric" });
			}
			this.#locale = resolved;
			this.#zone = zone;
			const data = L(resolved.dataTag).date;
			if (o.hour !== undefined || o.timeStyle !== undefined || o.dayPeriod !== undefined) {
				this.#hourCycle = hour12 !== undefined ? (hour12 ? data.hc12 : data.hc24) : (hourCycle ?? data.hourCycle);
			}
			this.#o = o;
			this.#tokens = this.#choosePattern();
			Object.defineProperty(this, "format", { value: (date) => this.formatToParts(date).map((p) => p.value).join(""), configurable: true, writable: true });
		}

		#choosePattern() {
			const o = this.#o;
			const locale = L(this.#locale.dataTag);
			const d = locale.date;
			const cycle = this.#hourCycle ?? "h23";
			const key12 = cycle === "h11" || cycle === "h12" ? "h12" : "h23";
			if (o.dateStyle || o.timeStyle) return decodePattern(locale, d.styles[`${o.dateStyle ?? ""}|${o.timeStyle ?? ""}`][o.timeStyle ? cycle : "h12"]);
			const lookup = (key) => (d.patterns[key] !== undefined ? decodePattern(locale, d.patterns[key]) : null);
			const has = (n) => o[n] !== undefined;
			const dateKey = has("year") || has("month") || has("day") || has("weekday") ? `${o.year ?? ""}|${o.month ?? ""}|${o.day ?? ""}|${o.weekday ?? ""}` : null;
			let datePattern = null;
			if (dateKey !== null) {
				if (o.era) datePattern = lookup(`E|${o.era}|${dateKey}`);
				datePattern ??= lookup(`D|${dateKey}`) ?? this.#nearestDate(o, locale);
				if (o.era && !datePattern.some((t) => Array.isArray(t) && t[0] === "era")) datePattern = [...datePattern, " ", ["era", o.era]];
			}
			const tz = o.timeZoneName;
			let timePattern = null;
			let combined = null;
			if (o.weekday && !has("year") && !has("month") && !has("day") && has("hour") && !o.dayPeriod && !tz) {
				combined = lookup(`W|${cycle}|${o.weekday}|${o.hour}|${o.minute ?? ""}|${o.second ?? ""}`);
			}
			if (combined) return combined;
			if (has("hour") || has("minute") || has("second") || has("dayPeriod")) {
				const minute = o.minute ?? "";
				const second = o.second ?? (o.fractionalSecondDigits !== undefined && o.minute !== undefined ? "2-digit" : "");
				if (o.dayPeriod && !has("hour")) timePattern = lookup(`P|${o.dayPeriod}`);
				else if (o.dayPeriod) timePattern = lookup(`T|${cycle}|numeric|${minute ? "2-digit" : ""}|dp:${o.dayPeriod}`);
				else if (tz && has("hour")) timePattern = lookup(`Z|${tz}|${cycle}|${o.hour}|${minute}|${second}`);
				timePattern ??= lookup(`T|${cycle}|${o.hour ?? ""}|${minute}|${second}`) ?? lookup(`T|${cycle}|numeric|${minute}|${second}`) ?? [["hour", "numeric"]];
			}
			if (has("fractionalSecondDigits")) {
				const fraction = ["fractionalSecond", String(o.fractionalSecondDigits)];
				const at = (timePattern ?? []).findIndex((t) => Array.isArray(t) && t[0] === "second");
				timePattern = at < 0 ? [...(timePattern ?? []), fraction] : [...timePattern.slice(0, at + 1), fraction, ...timePattern.slice(at + 1)];
			}
			let pattern;
			if (datePattern && timePattern) {
				const klass = o.month === "long" ? (o.weekday ? "full" : "long") : o.month === "short" ? "medium" : "short";
				pattern = [...datePattern, d.glue[klass][key12], ...timePattern];
			} else pattern = datePattern ?? timePattern ?? [];
			if (tz && !pattern.some((t) => Array.isArray(t) && t[0] === "timeZoneName")) {
				let withZone = null;
				if (!timePattern && datePattern) withZone = lookup(`Z|${tz}|D|${dateKey}`);
				if (!timePattern && !datePattern) withZone = lookup(`Z|${tz}|Z`);
				if (withZone) pattern = withZone;
				else if (!timePattern && datePattern) pattern = [...pattern, d.glue[o.month === "long" ? (o.weekday ? "full" : "long") : o.month === "short" ? "medium" : "short"][key12], ["timeZoneName", tz]];
				else pattern = [...pattern, " ", ["timeZoneName", tz]];
			}
			return pattern;
		}
		#nearestDate(o, locale) {
			const d = locale.date;
			for (const c of [`${o.year ?? ""}|${o.month ?? ""}|${o.day ?? ""}|`, `${o.year ?? ""}|${o.month ?? ""}||`, `|${o.month ?? ""}|${o.day ?? ""}|`]) if (d.patterns[`D|${c}`] !== undefined) return decodePattern(locale, d.patterns[`D|${c}`]);
			return [["year", "numeric"]];
		}

		#fields(date) {
			const ms = date === undefined ? Date.now() : date instanceof Date ? date.getTime() : Number(date);
			if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new RangeError("Invalid time value");
			const state = stateAt(this.#zone, ms);
			const local = ms + state.offset * 1000;
			const days = Math.floor(local / 86400000);
			const secondOfDay = Math.floor((local - days * 86400000) / 1000);
			const { year, month, day } = civilFromDays(days);
			return { year, month, day, weekday: (((days + 4) % 7) + 7) % 7, hour: Math.floor(secondOfDay / 3600), minute: Math.floor((secondOfDay % 3600) / 60), second: secondOfDay % 60, ms: (((Math.floor(local) % 1000) + 1000) % 1000), ms0: ms, state };
		}

		formatToParts(date) {
			const f = this.#fields(date);
			const d = L(this.#locale.dataTag).date;
			const cycle = this.#hourCycle;
			const parts = [];
			const pad = (n, style) => (style === "2-digit" ? String(n).padStart(2, "0") : String(n));
			for (const token of this.#tokens) {
				if (typeof token === "string") {
					parts.push({ type: "literal", value: token });
					continue;
				}
				const [type, style] = token;
				switch (type) {
					case "year": {
						const y = f.year <= 0 ? 1 - f.year : f.year;
						parts.push({ type: "year", value: style === "2-digit" ? String(y % 100).padStart(2, "0") : String(y) });
						break;
					}
					case "month": parts.push({ type: "month", value: style === "numeric" || style === "2-digit" ? pad(f.month, style) : d.months[style][f.month - 1] }); break;
					case "day": parts.push({ type: "day", value: pad(f.day, style) }); break;
					case "weekday": parts.push({ type: "weekday", value: d.weekdays[style][f.weekday] }); break;
					case "era": parts.push({ type: "era", value: d.eras[style][f.year > 0 ? 1 : 0] }); break;
					case "hour": {
						let h = f.hour;
						if (cycle === "h12") h = h % 12 === 0 ? 12 : h % 12;
						else if (cycle === "h11") h %= 12;
						else if (cycle === "h24") h = h === 0 ? 24 : h;
						parts.push({ type: "hour", value: pad(h, style) });
						break;
					}
					case "minute": parts.push({ type: "minute", value: pad(f.minute, style) }); break;
					case "second": parts.push({ type: "second", value: pad(f.second, style) }); break;
					case "fractionalSecond": parts.push({ type: "fractionalSecond", value: String(f.ms).padStart(3, "0").slice(0, Number(style)) }); break;
					case "dayPeriod": parts.push({ type: "dayPeriod", value: style?.startsWith("flex-") ? d.flexible[style.slice(5)][f.hour] : d.dayPeriods[f.hour >= 12 ? 1 : 0] }); break;
					case "timeZoneName": parts.push({ type: "timeZoneName", value: this.#zoneName(f.state, style, f.ms0) }); break;
					default: break;
				}
			}
			// Adjacent literals are one part, as ICU reports them.
			for (let i = parts.length - 1; i > 0; i--) {
				if (parts[i].type === "literal" && parts[i - 1].type === "literal") {
					parts[i - 1] = { type: "literal", value: parts[i - 1].value + parts[i].value };
					parts.splice(i, 1);
				}
			}
			// ICU writes seconds and their fraction as one field: the locale's decimal separator goes between them.
			const fraction = parts.findIndex((p) => p.type === "fractionalSecond");
			if (fraction > 0 && parts[fraction - 1].type === "second") parts.splice(fraction, 0, { type: "literal", value: L(this.#locale.dataTag).number.decimal });
			return parts;
		}

		#zoneName(state, style, ms) {
			const zone = this.#zone;
			const locale = L(this.#locale.dataTag);
			const gmt = locale.gmt;
			const offsetText = (long) => {
				if (state.offset === 0) return long ? `${gmt.prefix}${gmt.plus}00${gmt.sep}00` : gmt.zero;
				const total = Math.abs(state.offset);
				const h = Math.floor(total / 3600);
				const m = Math.floor((total % 3600) / 60);
				const s = total % 60;
				const two = (n) => String(n).padStart(2, "0");
				return `${gmt.prefix}${state.offset < 0 ? gmt.minus : gmt.plus}${long ? two(h) : h}${long || m || s ? `${gmt.sep}${two(m)}` : ""}${s ? `${gmt.sep}${two(s)}` : ""}`;
			};
			if (style === "shortOffset") return offsetText(false);
			if (style === "longOffset") return offsetText(true);
			if (zone.canonical) {
				// Names are per metazone interval (Berlin has none before 1970; Lord Howe changed metazone in 1981).
				const starts = zoneRecord(zone.canonical).names;
				let interval = 0;
				while (interval < starts.length && starts[interval] <= ms / 1000) interval++;
				const entry = locale.zoneNames.zones[zone.canonical];
				const index = Array.isArray(entry) ? entry[interval] : entry;
				const tuple = index === undefined ? null : locale.zoneNames.tuples[index];
				// A zone with no daylight time within a year either side is named by its standard name, generically too.
				const quiet = !state.dst && [-182, -91, 91, 182].every((d) => !stateAt(zone, ms + d * 86400000).dst);
				const pick = tuple && { short: tuple[state.dst ? 1 : 0], long: tuple[state.dst ? 3 : 2], shortGeneric: tuple[quiet ? 8 : state.dst ? 5 : 4], longGeneric: tuple[quiet ? 9 : state.dst ? 7 : 6] }[style];
				if (pick) return pick;
			}
			return offsetText(style === "long" || style === "longGeneric");
		}

		formatRange(start, end) {
			return this.formatRangeToParts(start, end).map((p) => p.value).join("");
		}
		formatRangeToParts(start, end) {
			if (start === undefined || end === undefined) throw new TypeError("startDate or endDate is undefined");
			const a = this.formatToParts(start);
			const b = this.formatToParts(end);
			if (a.map((p) => p.value).join("") === b.map((p) => p.value).join("")) return a.map((p) => ({ ...p, source: "shared" }));
			return [...a.map((p) => ({ ...p, source: "startRange" })), { type: "literal", value: L(this.#locale.dataTag).date.rangeSep, source: "shared" }, ...b.map((p) => ({ ...p, source: "endRange" }))];
		}
		resolvedOptions() {
			const o = this.#o;
			const out = { locale: this.#locale.locale, calendar: "gregory", numberingSystem: "latn", timeZone: this.#zone.name };
			if (this.#hourCycle) {
				out.hourCycle = this.#hourCycle;
				out.hour12 = this.#hourCycle === "h11" || this.#hourCycle === "h12";
			}
			if (o.dateStyle || o.timeStyle) {
				if (o.dateStyle) out.dateStyle = o.dateStyle;
				if (o.timeStyle) out.timeStyle = o.timeStyle;
				return out;
			}
			// The style each field is really shown in comes from the pattern that was chosen.
			const shown = {};
			for (const t of this.#tokens) if (Array.isArray(t)) shown[t[0]] = t[1];
			for (const key of ["weekday", "era", "year", "month", "day", "dayPeriod", "hour", "minute", "second"]) {
				if (o[key] === undefined) continue;
				let value = key === "dayPeriod" || key === "era" ? o[key] : (shown[key] ?? o[key]);
				if (typeof value === "string" && value !== "2-digit" && value.includes("-")) value = value.split("-")[0];
				out[key] = value;
			}
			if (o.fractionalSecondDigits !== undefined) out.fractionalSecondDigits = o.fractionalSecondDigits;
			if (o.timeZoneName !== undefined) out.timeZoneName = o.timeZoneName;
			return out;
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.DateTimeFormat";
		}
	}

	// ---- PluralRules, RelativeTimeFormat, ListFormat ---------------------------------------------------------------------------------------------
	class PluralRules {
		#locale;
		#type;
		#nf;
		constructor(locales, options) {
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "PluralRules", options);
			this.#type = getOption(options, "type", "string", ["cardinal", "ordinal"], "cardinal", "Intl.PluralRules");
			const digits = {};
			for (const k of ["minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay"]) if (options[k] !== undefined) digits[k] = options[k];
			this.#nf = new NumberFormat(this.#locale.locale, { ...digits, useGrouping: false });
		}
		select(n) {
			const text = this.#nf.formatToParts(Number(n)).filter((p) => ["integer", "fraction", "decimal", "nan", "infinity"].includes(p.type)).map((p) => (p.type === "decimal" ? "." : p.value)).join("");
			return /^\d/.test(text) ? pluralCategory(this.#locale.dataTag, this.#type, text) : "other";
		}
		selectRange(start, end) {
			if (start === undefined || end === undefined) throw new TypeError("start or end is undefined");
			return this.select(Number(end));
		}
		resolvedOptions() {
			const r = this.#nf.resolvedOptions();
			const out = { locale: this.#locale.locale, type: this.#type, notation: "standard", minimumIntegerDigits: r.minimumIntegerDigits };
			if (r.minimumFractionDigits !== undefined) Object.assign(out, { minimumFractionDigits: r.minimumFractionDigits, maximumFractionDigits: r.maximumFractionDigits });
			if (r.minimumSignificantDigits !== undefined) Object.assign(out, { minimumSignificantDigits: r.minimumSignificantDigits, maximumSignificantDigits: r.maximumSignificantDigits });
			out.pluralCategories = [...L(this.#locale.dataTag).plural[this.#type]].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
			out.roundingIncrement = r.roundingIncrement;
			out.roundingMode = r.roundingMode;
			out.roundingPriority = r.roundingPriority;
			out.trailingZeroDisplay = r.trailingZeroDisplay;
			return out;
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.PluralRules";
		}
	}

	class RelativeTimeFormat {
		#locale;
		#style;
		#numeric;
		#nf;
		constructor(locales, options) {
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "NumberFormat", options);
			this.#style = getOption(options, "style", "string", ["long", "short", "narrow"], "long", "Intl.RelativeTimeFormat");
			this.#numeric = getOption(options, "numeric", "string", ["always", "auto"], "always", "Intl.RelativeTimeFormat");
			this.#nf = new NumberFormat(this.#locale.locale);
		}
		formatToParts(value, unit) {
			value = Number(value);
			if (!Number.isFinite(value)) throw new RangeError("Value need to be finite number for Intl.RelativeTimeFormat.prototype.format()");
			const canonical = String(unit).replace(/s$/, "");
			if (!["year", "quarter", "month", "week", "day", "hour", "minute", "second"].includes(canonical)) throw new RangeError(`Invalid unit argument for format() '${unit}'`);
			const data = L(this.#locale.dataTag).relative[this.#style][canonical];
			if (this.#numeric === "auto") {
				const special = data.auto[Object.is(value, -0) ? 0 : value];
				if (special !== undefined) return [{ type: "literal", value: special }];
			}
			const negative = value < 0 || Object.is(value, -0);
			const numberParts = this.#nf.formatToParts(Math.abs(value));
			const shown = numberParts.filter((p) => ["integer", "fraction", "decimal"].includes(p.type)).map((p) => (p.type === "decimal" ? "." : p.value)).join("");
			const table = negative ? data.past : data.future;
			const template = table[pluralCategory(this.#locale.dataTag, "cardinal", shown)] ?? table.other;
			const out = [];
			for (const chunk of template.split(/(\{n\})/)) {
				if (chunk === "{n}") out.push(...numberParts.map((p) => ({ ...p, unit: canonical })));
				else if (chunk) out.push({ type: "literal", value: chunk });
			}
			return out;
		}
		format(value, unit) {
			return this.formatToParts(value, unit).map((p) => p.value).join("");
		}
		resolvedOptions() {
			return { locale: this.#locale.locale, style: this.#style, numeric: this.#numeric, numberingSystem: "latn" };
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.RelativeTimeFormat";
		}
	}

	class ListFormat {
		#locale;
		#type;
		#style;
		constructor(locales, options) {
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "ListFormat", options);
			this.#type = getOption(options, "type", "string", ["conjunction", "disjunction", "unit"], "conjunction", "Intl.ListFormat");
			this.#style = getOption(options, "style", "string", ["long", "short", "narrow"], "long", "Intl.ListFormat");
		}
		formatToParts(list) {
			const items = list === undefined ? [] : Array.from(list, (x) => {
				if (typeof x !== "string") throw new TypeError(`Iterable yielded ${String(x)} which is not a string`);
				return x;
			});
			if (items.length === 0) return [];
			if (items.length === 1) return [{ type: "element", value: items[0] }];
			const patterns = L(this.#locale.dataTag).list[this.#type][this.#style];
			const parts = [];
			const emit = (template, values) => {
				for (const chunk of template.split(/(\{[a-d]\})/)) {
					const m = /^\{([a-d])\}$/.exec(chunk);
					if (m) parts.push({ type: "element", value: values[m[1]] });
					else if (chunk) parts.push({ type: "literal", value: chunk });
				}
			};
			if (items.length === 2) emit(patterns.two, { a: items[0], b: items[1] });
			else {
				const four = patterns.four;
				const startSep = four.slice(four.indexOf("}") + 1, four.indexOf("{b}"));
				const midSep = four.slice(four.indexOf("{b}") + 3, four.indexOf("{c}"));
				const endSep = four.slice(four.indexOf("{c}") + 3, four.indexOf("{d}"));
				const prefix = four.slice(0, four.indexOf("{a}"));
				const suffix = four.slice(four.indexOf("{d}") + 3);
				if (prefix) parts.push({ type: "literal", value: prefix });
				items.forEach((item, i) => {
					if (i > 0) parts.push({ type: "literal", value: i === 1 ? startSep : i === items.length - 1 ? endSep : midSep });
					parts.push({ type: "element", value: item });
				});
				if (suffix) parts.push({ type: "literal", value: suffix });
			}
			return parts;
		}
		format(list) {
			return this.formatToParts(list).map((p) => p.value).join("");
		}
		resolvedOptions() {
			return { locale: this.#locale.locale, type: this.#type, style: this.#style };
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.ListFormat";
		}
	}

	// ---- Collator ---------------------------------------------------------------------------------------------------------------------------------------
	const collation = { built: false };
	function buildCollation() {
		const c = D().collation;
		const [P, S, T] = c.separators;
		const weights = new Map();
		let p = 1;
		let s = 0;
		let t = 0;
		for (const ch of c.order) {
			if (ch === P) { p++; s = 0; t = 0; } else if (ch === S) { s++; t = 0; } else if (ch === T) t++;
			else weights.set(ch, [p, s, t]);
		}
		const marks = new Map();
		let m = 0;
		for (const ch of c.marks) {
			if (ch === S) m++;
			else marks.set(ch, 1000 + m);
		}
		Object.assign(collation, { built: true, weights, marks, maxPrimary: p, ignorable: new Set(c.ignorable), variable: new Set(c.variable), expansions: c.expansions, compat: c.compat, digitZeros: c.digitZeros, zeroPrimary: weights.get("0")[0] });
	}
	const hanCache = new Map();
	function hanWeights(dataTag) {
		const text = L(dataTag).han;
		if (!text) return null;
		if (!hanCache.has(dataTag)) {
			const map = new Map();
			let group = 0;
			for (const ch of text) {
				if (ch === "") group++;
				else map.set(ch, group);
			}
			map.count = group + 1;
			hanCache.set(dataTag, map);
		}
		return hanCache.get(dataTag);
	}
	function digitValue(ch) {
		const cp = ch.codePointAt(0);
		if (cp >= 48 && cp <= 57) return cp - 48;
		if (cp < 0x660) return -1;
		for (const zero of collation.digitZeros) if (cp >= zero && cp < zero + 10) return cp - zero;
		return -1;
	}
	// Scripts a locale sorts before Latin take the weights they have in the root order, squeezed in below the first Latin letter.
	const SCRIPT_PATTERNS = { Cyrillic: /\p{Script=Cyrillic}/u, Greek: /\p{Script=Greek}/u, Hangul: /\p{Script=Hangul}/u, Han: /\p{Script=Han}/u, Hiragana: /\p{Script=Hiragana}/u, Katakana: /\p{Script=Katakana}/u, Arabic: /\p{Script=Arabic}/u, Hebrew: /\p{Script=Hebrew}/u, Thai: /\p{Script=Thai}/u, Devanagari: /\p{Script=Devanagari}/u };
	const scriptRanges = new Map();
	function scriptRange(name) {
		let range = scriptRanges.get(name);
		if (!range) {
			range = { min: Infinity, max: -Infinity };
			for (const [ch, w] of collation.weights) {
				if (!SCRIPT_PATTERNS[name].test(ch)) continue;
				if (w[0] < range.min) range.min = w[0];
				if (w[0] > range.max) range.max = w[0];
			}
			scriptRanges.set(name, range);
		}
		return range;
	}
	const compareSequences = (x, y) => {
		const n = Math.min(x.length, y.length);
		for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
		return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
	};
	const COLLATOR = "Intl.Collator";

	class Collator {
		#locale;
		#o;
		#tailoring;
		#han;
		#reorder;
		#cache = new Map();
		constructor(locales, options) {
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "Collator", options);
			const usage = getOption(options, "usage", "string", ["sort", "search"], "sort", COLLATOR);
			getOption(options, "localeMatcher", "string", ["lookup", "best fit"], "best fit", COLLATOR);
			const collationOption = getOption(options, "collation", "string", undefined, undefined, COLLATOR);
			if (collationOption !== undefined && !/^[A-Za-z0-9]{3,8}(-[A-Za-z0-9]{3,8})*$/.test(collationOption)) throw new RangeError(`Invalid collation : ${collationOption}`);
			const keys = this.#locale.keys;
			const numeric = options.numeric === undefined ? keys.kn === "true" : Boolean(options.numeric);
			const caseFirst = getOption(options, "caseFirst", "string", ["upper", "lower", "false"], keys.kf ?? "false", COLLATOR);
			this.#o = { usage, sensitivity: getOption(options, "sensitivity", "string", ["base", "accent", "case", "variant"], "variant", COLLATOR), ignorePunctuation: getOption(options, "ignorePunctuation", "boolean", undefined, false, COLLATOR), numeric, caseFirst, collation: keys.co ?? (this.#locale.language === "zh" ? "pinyin" : "default") };
			this.#tailoring = L(this.#locale.dataTag).tailoring;
			this.#reorder = L(this.#locale.dataTag).reorder ?? [];
			Object.defineProperty(this, "compare", { value: (a, b) => this.#compare(String(a), String(b)), configurable: true, writable: true });
		}
		/** Collation elements of a string: primary weights, and per unit a secondary and tertiary weight and a case flag. */
		#key(text) {
			let key = this.#cache.get(text);
			if (key) return key;
			if (!collation.built) buildCollation();
			this.#han ??= hanWeights(this.#locale.dataTag) ?? false;
			const o = this.#o;
			const chars = [...text.normalize("NFD")];
			const key2 = { primary: [], secondary: [], tertiary: [], upper: [], hasPrimary: [] };
			const push = (p, s, t, upper) => {
				if (p !== 0) key2.primary.push(p);
				key2.secondary.push(s);
				key2.tertiary.push(t);
				key2.upper.push(upper);
				key2.hasPrimary.push(p !== 0);
			};
			const implicit = collation.maxPrimary + 2000000;
			for (let i = 0; i < chars.length; i++) {
				const ch = chars[i];
				if (collation.ignorable.has(ch)) continue;
				if (o.ignorePunctuation && collation.variable.has(ch)) continue;
				if (o.numeric && digitValue(ch) >= 0) {
					let j = i;
					let digits = "";
					while (j < chars.length && digitValue(chars[j]) >= 0) digits += digitValue(chars[j++]);
					digits = digits.replace(/^0+(?=\d)/, "");
					push(collation.zeroPrimary, 0, 0, false);
					push(digits.length + 1, 0, 0, false);
					for (const digit of digits) push(Number(digit) + 1, 0, 0, false);
					i = j - 1;
					continue;
				}
				let matched = false;
				for (let len = Math.min(3, chars.length - i); len >= 1 && !matched; len--) {
					const entry = this.#tailoring[chars.slice(i, i + len).join("")];
					if (!entry) continue;
					const base = collation.weights.get(entry.same ?? entry.after);
					push(entry.same !== undefined ? base[0] : base[0] + entry.n / (entry.of + 1), entry.s, entry.t, chars[i] !== chars[i].toLowerCase());
					i += len - 1;
					matched = true;
				}
				if (matched) continue;
				const w = collation.weights.get(ch);
				if (this.#reorder.length) {
					const k = this.#reorder.findIndex((name) => SCRIPT_PATTERNS[name].test(ch));
					if (k >= 0) {
						let fraction = 0.999;
						if (this.#reorder[k] === "Han" && this.#han) {
							const index = this.#han.get(ch);
							if (index !== undefined) fraction = (index + 0.5) / (this.#han.count + 1);
						} else if (w) {
							const range = scriptRange(this.#reorder[k]);
							fraction = (w[0] - range.min) / (range.max - range.min + 1);
						}
						push(collation.weights.get("a")[0] - 1 + (k + fraction) / this.#reorder.length, w ? w[1] : 0, w ? w[2] : 0, ch !== ch.toLowerCase());
						continue;
					}
				}
				if (w) {
					push(w[0], w[1], w[2], ch !== ch.toLowerCase());
					continue;
				}
				const mark = collation.marks.get(ch);
				if (mark !== undefined) {
					push(0, mark, 0, false);
					continue;
				}
				// A ligature sorts as its letters, a step above them; a compatibility form (fullwidth, circled) differs only in the tertiary weight.
				const expansion = collation.expansions[ch] ?? collation.compat[ch];
				if (expansion !== undefined) {
					const ligature = collation.expansions[ch] !== undefined;
					for (const e of [...expansion.normalize("NFD")]) {
						const ew = collation.weights.get(e);
						if (ew) push(ew[0], ew[1] + (ligature ? 1 : 0), ew[2] + (ligature ? 0 : 1), ch !== ch.toLowerCase());
					}
					continue;
				}
				const han = this.#han ? this.#han.get(ch) : undefined;
				push(han !== undefined ? collation.maxPrimary + 1 + han : implicit + ch.codePointAt(0), 0, 0, false);
			}
			key = key2;
			if (this.#cache.size > 4000) this.#cache.clear();
			this.#cache.set(text, key);
			return key;
		}
		#compare(a, b) {
			const o = this.#o;
			const ka = this.#key(a);
			const kb = this.#key(b);
			let c = compareSequences(ka.primary, kb.primary);
			if (c || o.sensitivity === "base") return c;
			if (o.sensitivity !== "case") {
				c = compareSequences(ka.secondary, kb.secondary);
				if (c || o.sensitivity === "accent") return c;
			}
			const caseWeights = (k) => k.upper.filter((_, i) => k.hasPrimary[i]).map((u) => (u ? 1 : 0));
			if (o.sensitivity === "case") return o.caseFirst === "upper" ? compareSequences(caseWeights(kb), caseWeights(ka)) : compareSequences(caseWeights(ka), caseWeights(kb));
			// Tertiary weights: case and width variants; "upper" puts a capital before its lower-case form.
			const tertiary = (k) => (o.caseFirst === "upper" ? k.tertiary.map((t, i) => (k.upper[i] ? t - 1000 : t)) : k.tertiary);
			return compareSequences(tertiary(ka), tertiary(kb));
		}
		resolvedOptions() {
			const o = this.#o;
			return { locale: this.#locale.locale, usage: o.usage, sensitivity: o.sensitivity, ignorePunctuation: o.ignorePunctuation, collation: o.collation, numeric: o.numeric, caseFirst: o.caseFirst };
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.Collator";
		}
	}

	// ---- DisplayNames ---------------------------------------------------------------------------------------------------------------------------------------
	class DisplayNames {
		#locale;
		#o;
		constructor(locales, options) {
			if (options === undefined) throw new TypeError("invalid_argument");
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "DisplayNames", options);
			const svc = "Intl.DisplayNames";
			const style = getOption(options, "style", "string", ["narrow", "short", "long"], "long", svc);
			const type = getOption(options, "type", "string", ["language", "region", "script", "currency", "calendar", "dateTimeField"], undefined, svc);
			if (type === undefined) throw new TypeError("invalid_argument");
			this.#o = { style, type, fallback: getOption(options, "fallback", "string", ["code", "none"], "code", svc), languageDisplay: getOption(options, "languageDisplay", "string", ["dialect", "standard"], "dialect", svc) };
		}
		of(code) {
			const { type, style, fallback, languageDisplay } = this.#o;
			const names = N(this.#locale.dataTag);
			const lookup = (kind, key) => (style !== "long" ? names[`${kind}:${style}`]?.[key] : undefined) ?? names[kind]?.[key];
			let shown = String(code);
			let value;
			switch (type) {
				case "region":
					if (!/^(?:[A-Za-z]{2}|\d{3})$/.test(shown)) throw new RangeError("invalid_argument");
					shown = shown.toUpperCase();
					value = lookup("region", shown);
					break;
				case "script":
					if (!/^[A-Za-z]{4}$/.test(shown)) throw new RangeError("invalid_argument");
					shown = titleCase(shown);
					value = lookup("script", shown);
					break;
				case "currency":
					if (!/^[A-Za-z]{3}$/.test(shown)) throw new RangeError("invalid_argument");
					shown = shown.toUpperCase();
					value = lookup("currency", shown);
					break;
				case "calendar":
					if (!/^[A-Za-z0-9]{3,8}(-[A-Za-z0-9]{3,8})*$/.test(shown)) throw new RangeError("invalid_argument");
					shown = shown.toLowerCase();
					value = names.calendar[shown];
					break;
				case "dateTimeField":
					if (!Object.hasOwn(names.dateTimeField.long, shown)) throw new RangeError("invalid_argument");
					value = names.dateTimeField[style][shown];
					break;
				default: {
					const parsed = parseTag(shown);
					if (!parsed || Object.keys(parsed.unicode).length || parsed.other.length || parsed.privateUse) throw new RangeError("invalid_argument");
					shown = canonicalizeTag(shown);
					const { language, script, region } = parseTag(shown);
					const dialects = new Proxy(names.dialect, { get: (table, key) => (style !== "long" ? names[`dialect:${style}`]?.[key] : undefined) ?? table[key] });
					let base;
					let usedScript = false;
					let usedRegion = false;
					if (languageDisplay === "dialect") {
						const tries = [[script && region ? `${language}-${script}-${region}` : null, true, true], [region && !script ? `${language}-${region}` : null, false, true], [script ? `${language}-${script}` : null, true, false], [region ? `${language}-${region}` : null, false, true]];
						for (const [candidate, s, r] of tries) {
							if (candidate && dialects[candidate]) {
								base = dialects[candidate];
								usedScript = s;
								usedRegion = r;
								break;
							}
						}
					}
					base ??= lookup("language", language);
					if (base === undefined) break;
					const extras = [];
					if (script && !usedScript) extras.push(lookup("script", script) ?? script);
					if (region && !usedRegion) extras.push(lookup("region", region) ?? region);
					value = extras.length ? `${base}${names.compose.open}${extras.join(names.compose.sep)}${names.compose.close}` : base;
				}
			}
			return value ?? (fallback === "code" ? shown : undefined);
		}
		resolvedOptions() {
			const o = this.#o;
			const out = { locale: this.#locale.locale, style: o.style, type: o.type, fallback: o.fallback };
			if (o.type === "language") out.languageDisplay = o.languageDisplay;
			return out;
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.DisplayNames";
		}
	}

	// ---- Locale ------------------------------------------------------------------------------------------------------------------------------------------------
	const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv", "ckb"]);
	function maximizeTag(t) {
		const data = D();
		if (t.script && t.region && data.likely[t.language]) return t;
		if (t.language === "und" && !t.script && !t.region) return { ...t, ...parseTag(data.likely.und) };
		const full = (t.script ? data.likelyScript[`${t.language}-${t.script}`] : undefined) ?? (t.region ? data.likelyScript[`${t.language}-${t.region.toUpperCase()}`] : undefined) ?? data.likely[t.language];
		if (!full) return t;
		const [, script, region] = full.split("-");
		return { ...t, script: t.script ?? script, region: t.region ?? region };
	}
	const bare = (t) => ({ ...t, unicode: {}, unicodeAttrs: [], other: [], privateUse: "" });
	class Locale {
		#tag;
		#t;
		constructor(tag, options) {
			if (typeof tag !== "string" && !(tag && typeof tag === "object")) throw new TypeError("First argument to Intl.Locale constructor can't be empty or missing");
			const t = parseTag(canonicalizeTag(tag instanceof Locale ? tag.toString() : String(tag), true));
			options = options === undefined ? Object.create(null) : coerceOptions(options);
			if (options.language !== undefined) {
				if (!/^(?:[A-Za-z]{2,3}|[A-Za-z]{5,8})$/.test(String(options.language))) throw new RangeError("Incorrect locale information provided");
				t.language = String(options.language).toLowerCase();
			}
			if (options.script !== undefined) {
				if (!/^[A-Za-z]{4}$/.test(String(options.script))) throw new RangeError("Incorrect locale information provided");
				t.script = String(options.script);
			}
			if (options.region !== undefined) {
				if (!/^(?:[A-Za-z]{2}|\d{3})$/.test(String(options.region))) throw new RangeError("Incorrect locale information provided");
				t.region = String(options.region);
			}
			for (const [option, key] of [["calendar", "ca"], ["collation", "co"], ["hourCycle", "hc"], ["caseFirst", "kf"], ["numberingSystem", "nu"]]) {
				if (options[option] === undefined) continue;
				const value = String(options[option]);
				if (option === "hourCycle" && !["h11", "h12", "h23", "h24"].includes(value)) throw new RangeError(`Value ${value} out of range for Intl.Locale options property hourCycle`);
				if (option === "caseFirst" && !["upper", "lower", "false"].includes(value)) throw new RangeError(`Value ${value} out of range for Intl.Locale options property caseFirst`);
				if (!/^[A-Za-z0-9]{3,8}(-[A-Za-z0-9]{3,8})*$/.test(value)) throw new RangeError("Incorrect locale information provided");
				t.unicode[key] = value.toLowerCase().split("-");
			}
			if (options.numeric !== undefined) t.unicode.kn = options.numeric ? [] : ["false"];
			this.#t = t;
			this.#tag = serializeTag(t);
		}
		get language() { return this.#t.language; }
		get script() { return this.#t.script ? titleCase(this.#t.script) : undefined; }
		get region() { return this.#t.region?.toUpperCase(); }
		get variants() { return this.#t.variants.length ? this.#t.variants.join("-") : undefined; }
		get baseName() { return serializeTag(bare(this.#t)); }
		get calendar() { return this.#t.unicode.ca?.join("-"); }
		get collation() { return this.#t.unicode.co?.join("-"); }
		get hourCycle() { return this.#t.unicode.hc?.join("-"); }
		get caseFirst() { return this.#t.unicode.kf ? this.#t.unicode.kf.join("-") || "true" : undefined; }
		get numeric() { const v = this.#t.unicode.kn; return v !== undefined && (v.length === 0 || v[0] === "true"); }
		get numberingSystem() { return this.#t.unicode.nu?.join("-"); }
		maximize() { return new Locale(serializeTag(maximizeTag(this.#t))); }
		minimize() {
			const t = this.#t;
			const max = maximizeTag(bare(t));
			const same = (x) => { const m = maximizeTag(bare(x)); return m.script === max.script && m.region === max.region && m.language === max.language; };
			for (const candidate of [{ ...t, script: undefined, region: undefined }, { ...t, script: undefined, region: max.region }, { ...t, script: max.script, region: undefined }]) if (same(candidate)) return new Locale(serializeTag(candidate));
			return new Locale(serializeTag(t));
		}
		getWeekInfo() {
			const w = D().weekInfo[maximizeTag(this.#t).region] ?? { firstDay: 1, minimalDays: 4, weekend: [6, 7] };
			return { firstDay: w.firstDay, weekend: [...w.weekend], minimalDays: w.minimalDays };
		}
		get weekInfo() { return this.getWeekInfo(); }
		getTextInfo() { return { direction: RTL.has(this.#t.language) ? "rtl" : "ltr" }; }
		get textInfo() { return this.getTextInfo(); }
		getCalendars() { return [this.calendar ?? "gregory"]; }
		get calendars() { return this.getCalendars(); }
		getCollations() { return this.collation ? [this.collation] : ["emoji", "eor"]; }
		get collations() { return this.getCollations(); }
		getHourCycles() {
			const tag = dataTagFor(this.#t);
			return [this.hourCycle ?? (tag ? L(tag).date.hourCycle : "h23")];
		}
		get hourCycles() { return this.getHourCycles(); }
		getNumberingSystems() { return [this.numberingSystem ?? "latn"]; }
		get numberingSystems() { return this.getNumberingSystems(); }
		toString() { return this.#tag; }
		get [Symbol.toStringTag]() { return "Intl.Locale"; }
	}

	// ---- DurationFormat ---------------------------------------------------------------------------------------------------------------------------------------------
	const DURATION_UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"];
	const DURATION = "Intl.DurationFormat";
	class DurationFormat {
		#locale;
		#o;
		constructor(locales, options) {
			options = coerceOptions(options);
			this.#locale = resolveLocale(locales, "NumberFormat", options);
			const style = getOption(options, "style", "string", ["long", "short", "narrow", "digital"], "short", DURATION);
			const o = { style, units: {}, fractionalDigits: options.fractionalDigits === undefined ? undefined : getNumberOption(options, "fractionalDigits", 0, 9, undefined) };
			let previous = null;
			for (const unit of DURATION_UNITS) {
				const clock = unit === "hours" || unit === "minutes" || unit === "seconds";
				const sub = !clock && ["milliseconds", "microseconds", "nanoseconds"].includes(unit);
				const allowed = clock ? ["long", "short", "narrow", "numeric", "2-digit"] : sub ? ["long", "short", "narrow", "numeric"] : ["long", "short", "narrow"];
				const given = getOption(options, unit, "string", allowed, undefined, DURATION);
				const displayGiven = getOption(options, `${unit}Display`, "string", ["auto", "always"], undefined, DURATION);
				let resolvedStyle = given;
				let displayDefault = "auto";
				if (resolvedStyle === undefined) {
					if (style === "digital") {
						resolvedStyle = clock ? (unit === "hours" ? "numeric" : "2-digit") : sub ? "numeric" : "short";
						if (clock) displayDefault = "always";
					} else if ((previous === "numeric" || previous === "2-digit") && (unit === "minutes" || unit === "seconds" || sub)) resolvedStyle = "numeric";
					else resolvedStyle = style;
				}
				if ((resolvedStyle === "numeric" || resolvedStyle === "2-digit") && (unit === "minutes" || unit === "seconds") && (previous === "numeric" || previous === "2-digit")) resolvedStyle = "2-digit";
				o.units[unit] = { style: resolvedStyle, display: displayGiven ?? displayDefault };
				previous = resolvedStyle;
			}
			this.#o = o;
		}
		formatToParts(duration) {
			if (duration === null || typeof duration !== "object") throw new TypeError("Argument must be a duration record");
			const o = this.#o;
			const values = {};
			let any = false;
			for (const unit of DURATION_UNITS) {
				const v = duration[unit];
				if (v !== undefined) {
					any = true;
					if (!Number.isFinite(Number(v)) || !Number.isInteger(Number(v))) throw new RangeError(`Invalid ${unit}: ${v}`);
				}
				values[unit] = v === undefined ? 0 : Number(v);
			}
			if (!any) throw new TypeError("Invalid duration format");
			const signs = new Set(DURATION_UNITS.map((u) => Math.sign(values[u])).filter(Boolean));
			if (signs.size > 1) throw new RangeError("Mixed-sign durations are not valid");
			const negative = signs.has(-1);
			const locale = this.#locale.locale;
			const numericStyle = (unit) => o.units[unit].style === "numeric" || o.units[unit].style === "2-digit";
			const merged = numericStyle("milliseconds");
			const groups = [];
			let run = [];
			const flush = () => {
				if (!run.length) return;
				const group = [];
				run.forEach((chunk, i) => {
					if (i) group.push({ type: "literal", value: ":" });
					group.push(...chunk);
				});
				groups.push(group);
				run = [];
			};
			for (const unit of DURATION_UNITS) {
				const cfg = o.units[unit];
				if (merged && (unit === "milliseconds" || unit === "microseconds" || unit === "nanoseconds")) continue;
				const singular = unit.slice(0, -1);
				let text = String(Math.abs(values[unit]));
				let fractionalDigits = null;
				if (unit === "seconds" && merged) {
					const nanos = BigInt(Math.abs(values.milliseconds)) * 1000000n + BigInt(Math.abs(values.microseconds)) * 1000n + BigInt(Math.abs(values.nanoseconds));
					const whole = BigInt(Math.abs(values.seconds)) + nanos / 1000000000n;
					text = `${whole}.${String(nanos % 1000000000n).padStart(9, "0")}`;
					fractionalDigits = o.fractionalDigits;
				}
				const zero = /^0(\.0*)?$/.test(text);
				if (zero && cfg.display === "auto") continue;
				const fractionOptions = fractionalDigits === undefined || fractionalDigits === null ? (merged && unit === "seconds" ? { minimumFractionDigits: 0, maximumFractionDigits: 9 } : {}) : { minimumFractionDigits: fractionalDigits, maximumFractionDigits: fractionalDigits };
				if (numericStyle(unit)) {
					const nf = new NumberFormat(locale, { minimumIntegerDigits: cfg.style === "2-digit" ? 2 : 1, useGrouping: false, ...fractionOptions });
					run.push(nf.formatToParts(text).map((p) => ({ ...p, unit: singular })));
				} else {
					flush();
					const nf = new NumberFormat(locale, { style: "unit", unit: singular, unitDisplay: cfg.style, ...fractionOptions });
					groups.push(nf.formatToParts(text).map((p) => ({ ...p, unit: singular })));
				}
			}
			flush();
			if (!groups.length) return [];
			if (negative) groups[0].unshift({ type: "minusSign", value: L(this.#locale.dataTag).number.minus });
			const listStyle = o.style === "digital" ? "short" : o.style;
			const list = new ListFormat(locale, { type: "unit", style: listStyle });
			const out = [];
			for (const part of list.formatToParts(groups.map((_, i) => `${i}`))) {
				const m = /^(\d+)$/.exec(part.value);
				if (part.type === "element" && m) out.push(...groups[Number(m[1])]);
				else out.push(part);
			}
			return out;
		}
		format(duration) {
			return this.formatToParts(duration).map((p) => p.value).join("");
		}
		resolvedOptions() {
			const o = this.#o;
			const out = { locale: this.#locale.locale, numberingSystem: "latn", style: o.style };
			for (const unit of DURATION_UNITS) {
				out[unit] = o.units[unit].style;
				out[`${unit}Display`] = o.units[unit].display;
			}
			if (o.fractionalDigits !== undefined) out.fractionalDigits = o.fractionalDigits;
			return out;
		}
		static supportedLocalesOf(locales, options) {
			return supportedLocalesOf(locales, options);
		}
		get [Symbol.toStringTag]() {
			return "Intl.DurationFormat";
		}
	}

	// ---- Intl itself and the toLocaleString family --------------------------------------------------------------------------------------------------------------------------
	const defineHidden = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
	// NumberFormat, DateTimeFormat and Collator can be called without `new`, as they always could.
	const callable = (Class, name, legacy) => new Proxy(Class, { apply: (target, _this, args) => {
		if (!legacy) throw new TypeError(`Constructor Intl.${name} requires 'new'`);
		return new target(...args);
	} });
	for (const [name, Class, legacy] of [["Collator", Collator, true], ["DateTimeFormat", DateTimeFormat, true], ["DisplayNames", DisplayNames], ["DurationFormat", DurationFormat], ["ListFormat", ListFormat], ["Locale", Locale], ["NumberFormat", NumberFormat, true], ["PluralRules", PluralRules], ["RelativeTimeFormat", RelativeTimeFormat]]) {
		if (typeof IntlObject[name] !== "function") defineHidden(IntlObject, name, callable(Class, name, legacy));
	}
	if (!IntlObject.getCanonicalLocales) {
		defineHidden(IntlObject, "getCanonicalLocales", (locales) => canonicalList(locales, false));
		defineHidden(IntlObject, "supportedValuesOf", (key) => {
			const data = D();
			switch (String(key)) {
				case "calendar": return [...data.supported.calendar];
				case "collation": return [...data.supported.collation];
				case "currency": return [...data.supported.currency];
				case "numberingSystem": return [...data.supported.numberingSystem];
				case "timeZone": return [...data.zoneList];
				case "unit": return [...data.supported.unit];
				default: throw new RangeError(`Invalid key : ${key}`);
			}
		});
	}
	if (!Object.hasOwn(IntlObject, Symbol.toStringTag)) Object.defineProperty(IntlObject, Symbol.toStringTag, { value: "Intl", configurable: true });

	// Formatters a program makes with only a locale (or nothing) are made once.
	const cached = new Map();
	const memo = (kind, locales, options, make) => {
		if (options !== undefined || (locales !== undefined && typeof locales !== "string")) return make();
		const key = `${kind}|${locales}`;
		let value = cached.get(key);
		if (!value) {
			value = make();
			cached.set(key, value);
		}
		return value;
	};
	const numberToLocale = function toLocaleString(locales, options) {
		return memo("number", locales, options, () => new NumberFormat(locales, options)).format(this.valueOf());
	};
	const patch = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
	patch(Number.prototype, "toLocaleString", numberToLocale);
	if (typeof BigInt !== "undefined") patch(BigInt.prototype, "toLocaleString", numberToLocale);
	const dateMethod = (name, required, defaultsFor) =>
		function (locales, options) {
			const time = Date.prototype.getTime.call(this);
			if (Number.isNaN(time)) return "Invalid Date";
			return memo(name, locales, options, () => new DateTimeFormat(locales, options, { required, defaults: defaultsFor })).format(time);
		};
	patch(Date.prototype, "toLocaleString", dateMethod("date-time", "any", "all"));
	patch(Date.prototype, "toLocaleDateString", dateMethod("date", "date", "date"));
	patch(Date.prototype, "toLocaleTimeString", dateMethod("time", "time", "time"));
	patch(Array.prototype, "toLocaleString", function toLocaleString(locales, options) {
		return Array.from({ length: this.length }, (_, i) => (this[i] === null || this[i] === undefined ? "" : this[i].toLocaleString(locales, options))).join(",");
	});
	patch(String.prototype, "localeCompare", function localeCompare(that, locales, options) {
		if (this === null || this === undefined) throw new TypeError("String.prototype.localeCompare called on null or undefined");
		return memo("collator", locales, options, () => new Collator(locales, options)).compare(String(this), String(that));
	});
	const caseMap = (upper) =>
		function (locales) {
			if (this === null || this === undefined) throw new TypeError(`String.prototype.toLocale${upper ? "Upper" : "Lower"}Case called on null or undefined`);
			const language = parseTag(locales === undefined ? envLocale() : (canonicalList(locales, false)[0] ?? envLocale()))?.language ?? "en";
			let s = String(this);
			if (language === "tr" || language === "az") s = upper ? s.replace(/i/g, "İ").replace(/ı/g, "I") : s.replace(/İ/g, "i").replace(/I/g, "ı");
			else if (language === "lt" && !upper) s = s.replace(/İ/g, "i̇");
			return upper ? s.toUpperCase() : s.toLowerCase();
		};
	patch(String.prototype, "toLocaleUpperCase", caseMap(true));
	patch(String.prototype, "toLocaleLowerCase", caseMap(false));
	return IntlObject;
}

export { installIntl };
