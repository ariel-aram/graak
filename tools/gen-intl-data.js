#!/usr/bin/env node
/**
 * Generates quickjs/runtime/intl-data.js: the slice of ICU/CLDR data the host's Intl needs, read out of Node's own ICU by
 * formatting sample values. Run it with a Node.js that has full ICU and a system tz database:
 *
 *   node tools/gen-intl-data.js
 *
 * What is captured is what a program can observe: number symbols and patterns, currency symbols and names, compact and unit
 * patterns, month, weekday and day-period names, a date or time pattern for every combination of components a formatter is
 * asked for, time-zone transitions and localized zone names, relative-time and list patterns, collation weights, and display
 * names. intl.js only assembles them, so the output matches ICU wherever the data covers the request. Every stored zone is
 * checked against ICU's own offsets before the file is written.
 */
const fs = require("node:fs");
const path = require("node:path");

const LOCALES = [
	"en-US",
	"en-GB",
	"en-AU",
	"en-CA",
	"en-IN",
	"en-NZ",
	"en-IE",
	"en-ZA",
	"en-SG",
	"de-DE",
	"de-AT",
	"de-CH",
	"fr-FR",
	"fr-CA",
	"fr-BE",
	"fr-CH",
	"es-ES",
	"es-MX",
	"es-AR",
	"es-CO",
	"es-CL",
	"es-US",
	"es-419",
	"it-IT",
	"it-CH",
	"pt-BR",
	"pt-PT",
	"nl-NL",
	"nl-BE",
	"sv-SE",
	"sv-FI",
	"pl-PL",
	"ru-RU",
	"tr-TR",
	"ja-JP",
	"zh-CN",
	"zh-TW",
	"zh-HK",
	"ko-KR",
];
const CURRENCIES = [
	"USD",
	"EUR",
	"GBP",
	"JPY",
	"CNY",
	"KRW",
	"INR",
	"BRL",
	"CAD",
	"AUD",
	"CHF",
	"MXN",
	"RUB",
	"SEK",
	"NOK",
	"DKK",
	"PLN",
	"TRY",
	"NZD",
	"SGD",
	"HKD",
	"ZAR",
	"AED",
	"SAR",
	"ILS",
	"THB",
	"IDR",
	"MYR",
	"PHP",
	"VND",
	"CZK",
	"HUF",
	"RON",
	"UAH",
	"EGP",
	"NGN",
	"ARS",
	"CLP",
	"COP",
	"PEN",
	"TWD",
	"BGN",
	"HRK",
	"ISK",
	"KWD",
	"BHD",
	"QAR",
	"PKR",
	"BDT",
	"LKR",
	"KES",
	"MAD",
	"DZD",
	"TND",
	"JOD",
	"OMR",
	"BTC",
];
const UNITS = [
	"acre",
	"bit",
	"byte",
	"celsius",
	"centimeter",
	"day",
	"degree",
	"fahrenheit",
	"fluid-ounce",
	"foot",
	"gallon",
	"gigabit",
	"gigabyte",
	"gram",
	"hectare",
	"hour",
	"inch",
	"kilobit",
	"kilobyte",
	"kilogram",
	"kilometer",
	"liter",
	"megabit",
	"megabyte",
	"meter",
	"microsecond",
	"mile",
	"mile-scandinavian",
	"milliliter",
	"millimeter",
	"millisecond",
	"minute",
	"month",
	"nanosecond",
	"ounce",
	"percent",
	"petabyte",
	"pound",
	"second",
	"stone",
	"terabit",
	"terabyte",
	"week",
	"yard",
	"year",
	"kilometer-per-hour",
	"mile-per-hour",
	"meter-per-second",
	"liter-per-kilometer",
	"mile-per-gallon",
];
// 2024-12-03 is a Tuesday. Day, hour, minute and second are single digits, so a padded rendering shows in the output, and
// December's long and short names differ where a language tells them apart (English has a short "July" and "June").
const SAMPLE = new Date(Date.UTC(2024, 11, 3, 5, 9, 4, 123));
// 2024-07-03: a one-digit month, so a padded month shows.
const SAMPLE_NUMBERS = new Date(Date.UTC(2024, 6, 3, 5, 9, 4, 123));

/* The pattern of a number's formatted parts: the first integer becomes "{n}", the grouping and fraction parts go, and the
 * rest (currency and unit words, literals) stays. */
function numberTemplate(parts) {
	let seen = false;
	return parts
		.map((p) => {
			if (p.type === "integer") {
				if (seen) return "";
				seen = true;
				return "{n}";
			}
			return ["decimal", "fraction", "group"].includes(p.type) ? "" : p.value;
		})
		.join("");
}

async function main() {
	const zone = await import("../quickjs/runtime/intl-zone.js");
	const out = {
		version: process.versions.icu,
		locales: {},
		names: {},
		currencyDigits: {},
		zones: {},
		links: {},
		zoneList: Intl.supportedValuesOf("timeZone"),
		likely: {},
	};

	// ---- time zones ----------------------------------------------------------------------------------------------
	// The transitions come from ICU itself, sampled and bisected to the second, because the system's tz database and the
	// one inside ICU differ before 1970 (backzone data) and in how they flag daylight time. The only thing taken from the
	// system is the POSIX rule that continues after the last transition, and only where it reproduces ICU.
	const ZONEINFO = "/usr/share/zoneinfo";
	function tzifFiles(dir = "", found = []) {
		for (const entry of fs.readdirSync(path.join(ZONEINFO, dir), { withFileTypes: true })) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (["posix", "right"].includes(entry.name)) continue;
				tzifFiles(rel, found);
			} else found.push(rel);
		}
		return found;
	}
	function footerOf(name) {
		try {
			const buf = fs.readFileSync(path.join(ZONEINFO, name));
			if (buf.toString("latin1", 0, 4) !== "TZif" || buf[4] < 0x32) return "";
			const end = buf.lastIndexOf(10);
			return buf.toString("latin1", buf.lastIndexOf(10, end - 1) + 1, end);
		} catch {
			return "";
		}
	}
	/** The instants (seconds) at which the system's tz database changes offset: extra places to look for ICU's own changes. */
	function systemTransitions(name) {
		try {
			const buf = fs.readFileSync(path.join(ZONEINFO, name));
			if (buf.toString("latin1", 0, 4) !== "TZif" || buf[4] < 0x32) return [];
			const counts = (pos) => [20, 24, 28, 32, 36, 40].map((o) => buf.readUInt32BE(pos + o));
			let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0);
			const pos = 44 + timecnt * 4 + timecnt + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
			[isut, isstd, leap, timecnt, typecnt, charcnt] = counts(pos);
			const times = [];
			for (let i = 0, p = pos + 44; i < timecnt; i++, p += 8) times.push(Number(buf.readBigInt64BE(p)));
			return times;
		} catch {
			return [];
		}
	}
	const canonicalOf = (name) => {
		try {
			return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
		} catch {
			return null;
		}
	};
	const formatters = {};
	const icuOffset = (name, ms) => {
		formatters[name] ??= new Intl.DateTimeFormat("en-US", {
			timeZone: name,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		const f = formatters[name];
		const m = /^(\d+)\/(\d+)\/(\d+),? (\d+):(\d+):(\d+)/.exec(f.format(ms));
		return (
			zone.daysFromCivil(Number(m[3]), Number(m[1]), Number(m[2])) * 86400 +
			Number(m[4]) * 3600 +
			Number(m[5]) * 60 +
			Number(m[6]) -
			Math.floor(ms / 1000)
		);
	};
	const DAY = 86400000;
	function sampleZone(name, endYear = 2040, extra = []) {
		const START = Date.UTC(1700, 0, 1);
		const END = Date.UTC(endYear, 0, 1);
		const initial = icuOffset(name, START);
		const segments = []; // { at (seconds), offset }
		let previous = initial;
		const points = new Set();
		for (let t = START; t <= END; t += 9 * DAY) points.add(t);
		for (const seconds of extra)
			for (const d of [-3 * DAY, -DAY, -3600000, -1000, 1000, 3600000, DAY, 3 * DAY])
				if (seconds * 1000 + d > START && seconds * 1000 + d < END) points.add(seconds * 1000 + d);
		const grid = [...points].sort((x, y) => x - y);
		for (let i = 1; i < grid.length; i++) {
			if (icuOffset(name, grid[i]) === previous) continue;
			let lo = grid[i - 1];
			let hi = grid[i];
			while (hi - lo > 1000) {
				const mid = Math.floor((lo + hi) / 2000) * 1000;
				if (icuOffset(name, mid) === previous) lo = mid;
				else hi = mid;
			}
			previous = icuOffset(name, hi);
			segments.push({ at: Math.floor(hi / 1000), offset: previous });
			// The state at this point may already have changed again before the next grid point: look at it again.
			if (icuOffset(name, grid[i]) !== previous) i--;
		}
		// Daylight time is a segment that sits above the one before it and the one after it. (A change of standard time, like
		// Samoa moving across the date line, only steps up or only steps down; and the state with the higher offset in
		// a cycle is daylight time even where tzdata calls Ireland's winter "negative daylight saving".)
		const flags = segments.map((seg, i) => {
			const before = i === 0 ? initial : segments[i - 1].offset;
			// The last one has nothing after it: it is daylight time if the cycle before it was.
			const after =
				i + 1 < segments.length
					? segments[i + 1].offset
					: i >= 2 && segments[i - 2].offset === seg.offset
						? before
						: null;
			return before < seg.offset && after !== null && after < seg.offset ? 1 : 0;
		});
		return {
			initial: [initial, 0],
			at: segments.map((s) => s.at),
			offsets: segments.map((s) => s.offset),
			dsts: flags,
			rule: "",
		};
	}
	function withRule(name, record) {
		const rule = [name, ...Object.keys(records)].map(footerOf).find(Boolean);
		void rule;
		return record;
	}
	void withRule;
	const cacheFile = process.env.INTL_ZONE_CACHE;
	if (cacheFile && fs.existsSync(cacheFile)) {
		const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		out.zones = cached.zones;
		out.links = cached.links;
	} else {
		const canonicalNames = new Map();
		const allNames = [...new Set([...tzifFiles(), ...out.zoneList, "UTC", "GMT", "Etc/UTC", "Etc/GMT"])];
		const records = {};
		for (const name of allNames) {
			const canonical = canonicalOf(name);
			if (!canonical) continue;
			canonicalNames.set(name, canonical);
			if (name !== canonical) out.links[name] = canonical;
		}
		for (const canonical of new Set(canonicalNames.values())) {
			const extra = [
				...new Set(
					[canonical, ...[...canonicalNames].filter(([, c]) => c === canonical).map(([n]) => n)].flatMap(
						systemTransitions
					)
				),
			];
			let record = sampleZone(canonical, 2040, extra);
			// Continue with the system's POSIX rule if it reproduces ICU from 2007 to 2100 and at the last transition.
			const footer = [canonical, ...[...canonicalNames].filter(([, c]) => c === canonical).map(([n]) => n)]
				.map(footerOf)
				.find(Boolean);
			if (footer) {
				let ok = true;
				for (let ms = Date.UTC(2007, 0, 1); ms < Date.UTC(2100, 0, 1) && ok; ms += 3 * DAY + 1000)
					if (zone.evaluatePosixTz(footer, ms).offset !== icuOffset(canonical, ms)) ok = false;
				const last = record.at.length - 1;
				if (ok) {
					// Drop the trailing transitions the rule already produces.
					let keep = last;
					const sameOffset = (i, ms) =>
						(i < 0 ? record.initial[0] : record.offsets[i]) === zone.evaluatePosixTz(footer, ms).offset;
					while (
						keep >= 0 &&
						record.at[keep] >= Date.UTC(2007, 0, 1) / 1000 &&
						sameOffset(keep, record.at[keep] * 1000) &&
						sameOffset(keep - 1, record.at[keep] * 1000 - 1000)
					)
						keep--;
					if (keep < last) {
						record.ruleFrom = record.at[keep + 1];
						record.at = record.at.slice(0, keep + 1);
						record.offsets = record.offsets.slice(0, keep + 1);
						record.dsts = record.dsts.slice(0, keep + 1);
						record.rule = footer;
					}
				}
			}
			// ICU's rules for this zone differ from the system's: record its transitions out to 2100 instead.
			if (!record.rule) record = sampleZone(canonical, 2100, extra);
			out.zones[canonical] = record;
			records[canonical] = record;
		}
		// Check every zone against ICU: 1 August 1750 to 2100, sampled every 11 days, plus a fine sweep around each transition.
		let bad = 0;
		for (const [name, record] of Object.entries(out.zones)) {
			const instants = [];
			for (let ms = Date.UTC(1750, 7, 1); ms < Date.UTC(2100, 0, 1); ms += 11 * DAY + 3600000 * 5 + 61000)
				instants.push(ms);
			for (const s of record.at) for (const d of [-2, -1, 0, 1, 2]) instants.push((s + d) * 1000);
			instants.push(Date.UTC(1, 0, 1), Date.UTC(900, 0, 1), Date.UTC(1500, 5, 1));
			for (const ms of instants) {
				const got = zone.zoneStateAt(record, ms).offset;
				const want = icuOffset(name, ms);
				if (got !== want) {
					if (bad++ < 25)
						process.stderr.write(
							`zone mismatch ${name} ${new Date(ms).toISOString()}: ${got} vs ICU ${want} ${process.env.DEBUG_ZONE === name ? JSON.stringify(record.at.map((a, i) => [new Date(a * 1000).toISOString(), record.offsets[i]]).filter(([d]) => Math.abs(new Date(d) - ms) < 4e10)) + record.rule + record.ruleFrom : ""}\n`
						);
					break;
				}
			}
		}
		if (bad) throw new Error(`${bad} zones disagree with ICU`);
		process.stderr.write(`${Object.keys(out.zones).length} zones, ${Object.keys(out.links).length} links, verified\n`);

		if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify({ zones: out.zones, links: out.links }));
	}

	// ICU names a zone through the "metazone" it belonged to at that time: Central European Time for Berlin since 1970, and before
	// that only an offset; Lord Howe was in Australian Eastern Time until 1981. So a zone's names are per interval, found by
	// following the English generic name (which changes with the metazone) through the years.
	const NAME_FROM = Date.UTC(1800, 0, 1);
	const NAME_TO = Date.UTC(2025, 6, 1);
	const isOffsetName = (name) => /^(GMT|UTC|[^\d\s]{2,5})[+\-\u2212]\d/.test(name);
	for (const [name, record] of Object.entries(out.zones)) {
		const specific = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "long", hour: "numeric" });
		const short = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "shortGeneric", hour: "numeric" });
		const tz = (f, ms) => f.formatToParts(ms).find((p) => p.type === "timeZoneName").value;
		// What a zone is called at an instant, ignoring which season it is (Berlin's two names are one metazone, but so are
		// London's "Greenwich Mean Time" and "British Summer Time"): the names it has at that instant and half a year on.
		const label = (ms) => {
			const named = tz(specific, ms);
			return `${tz(short, ms)}|${name === "UTC" || !isOffsetName(named) ? named.replace(/\b(Standard|Daylight|Summer) /, "") : "offset"}`;
		};
		const set = (ms) => [...new Set([label(ms), label(ms + 182 * DAY)])].sort();
		const key = (ms) => set(ms).join("~");
		const starts = [];
		let previous = key(NAME_FROM);
		let cursor = NAME_FROM;
		while (cursor < NAME_TO) {
			const next = Math.min(cursor + 90 * DAY, NAME_TO);
			if (key(next) === previous) {
				cursor = next;
				continue;
			}
			// The window looks half a year ahead, so the change shows early: find the instant the new names begin.
			const oldSet = new Set(set(cursor));
			const newOnly = (ms) => !oldSet.has(label(ms));
			let t = cursor;
			while (t < next + 200 * DAY && !newOnly(t)) t += DAY;
			let lo = t - DAY;
			let hi = t;
			while (hi - lo > 1000) {
				const mid = Math.floor((lo + hi) / 2000) * 1000;
				if (newOnly(mid)) hi = mid;
				else lo = mid;
			}
			starts.push(Math.floor(hi / 1000));
			previous = key(hi);
			cursor = hi;
		}
		if (starts.length) record.m = starts;
	}
	/**
	 * Instants inside [from, to) where the zone is on standard and on daylight time (the last of each). A stretch flagged as
	 * daylight time whose English name is the standard one (Moscow's permanent +4 of 2011 to 2014) does not count.
	 */
	const seasonsIn = (name, record, from, to) => {
		const f = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "long", hour: "numeric" });
		const label = (ms) => f.formatToParts(ms).find((p) => p.type === "timeZoneName").value;
		const standard = [];
		const daylight = [];
		const consider = (ms) => {
			if (ms < from || ms >= to) return;
			(zone.zoneStateAt(record, ms).dst ? daylight : standard).push(ms);
		};
		consider(from + 86400000);
		for (let i = 0; i < record.at.length; i++) consider((record.at[i] + 86400) * 1000);
		// Zones ruled by a POSIX rule after their last transition: sample the months of the last year of the interval.
		if (record.rule) for (let m = 0; m < 12; m++) consider(Math.min(to - 86400000, Date.UTC(2024, m, 15, 12)));
		const std = standard.at(-1) ?? daylight.at(-1) ?? from + 86400000;
		const stdLabel = label(std);
		const dst = [...daylight].reverse().find((ms) => label(ms) !== stdLabel) ?? std;
		// Where a zone keeps no daylight time for a year either side, ICU's generic name is its standard name.
		const quiet = (ms) =>
			[-182, -91, 91, 182].every((d) => !zone.zoneStateAt(record, ms + d * 86400000).dst) &&
			!zone.zoneStateAt(record, ms).dst;
		const flat = [...standard].reverse().find(quiet) ?? std;
		return { std, dst, flat };
	};

	// ---- number data ------------------------------------------------------------------------------------------------
	const digitsOf = (code) =>
		new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
	for (const code of CURRENCIES) out.currencyDigits[code] = digitsOf(code);
	const CURRENCY_LIST = Intl.supportedValuesOf("currency");
	for (const code of CURRENCY_LIST) out.currencyDigits[code] ??= digitsOf(code);

	function categorySamples(locale, type = "cardinal") {
		const rules = new Intl.PluralRules(locale, { type });
		const samples = {};
		for (let n = 0; n <= 200; n++) samples[rules.select(n)] ??= n;
		for (const n of [0.5, 1.5, 2.5, 5.5]) samples[rules.select(n)] ??= n;
		return samples;
	}
	const templateOf = (parts, { mapCurrency = false, symbol = "" } = {}) => {
		let seenInteger = false;
		return parts
			.map((p) => {
				if (p.type === "integer") {
					if (seenInteger) return "";
					seenInteger = true;
					return "{n}";
				}
				if (["group", "decimal", "fraction"].includes(p.type)) return "";
				if (p.type === "minusSign") return "{-}";
				if (p.type === "plusSign") return "{+}";
				if (p.type === "percentSign") return "{%}";
				if (p.type === "currency") return mapCurrency && p.value === symbol ? "{s}" : "{c}";
				return p.value;
			})
			.join("");
	};

	function numberData(locale) {
		const d = {};
		const nf = new Intl.NumberFormat(locale, { useGrouping: true });
		const parts = nf.formatToParts(-1234567.891);
		d.decimal = parts.find((p) => p.type === "decimal").value;
		d.group = parts.find((p) => p.type === "group").value;
		d.minus = parts.find((p) => p.type === "minusSign").value;
		d.plus = new Intl.NumberFormat(locale, { signDisplay: "always" })
			.formatToParts(5)
			.find((p) => p.type === "plusSign").value;
		d.infinity = new Intl.NumberFormat(locale).format(Infinity);
		d.nan = new Intl.NumberFormat(locale).format(NaN);
		d.exp =
			new Intl.NumberFormat(locale, { notation: "scientific" })
				.formatToParts(12345)
				.find((p) => p.type === "exponentSeparator")?.value ?? "E";
		d.minGrouping = new Intl.NumberFormat(locale).format(1234) === "1234" ? 2 : 1;
		const groupSizes = (format) => {
			const segments = format.format(123456789).split(d.group);
			return segments.length > 2 && segments[segments.length - 2].length === 2 ? [3, 2] : [3, 3];
		};
		d.groupSizes = groupSizes(new Intl.NumberFormat(locale));
		const pct = new Intl.NumberFormat(locale, { style: "percent" });
		d.percent = templateOf(pct.formatToParts(0.5));
		d.percentNeg = templateOf(pct.formatToParts(-0.5));
		d.percentSign = pct.formatToParts(0.5).find((p) => p.type === "percentSign").value;
		// ICU spaces a percent sign differently after a compact number.
		const compactPct = new Intl.NumberFormat(locale, { style: "percent", notation: "compact" });
		d.percentCompact = templateOf(compactPct.formatToParts(0.5));
		d.percentCompactNeg = templateOf(compactPct.formatToParts(-0.5));
		d.currency = {};
		// Templates come from a currency whose symbol ends in a symbol character, so ICU's currency spacing does not put a
		// no-break space into them; the run time adds that space where the symbol is a letter.
		const edgeSymbol = (code, display) =>
			new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: display })
				.formatToParts(1)
				.find((p) => p.type === "currency").value;
		const isSymbolic = (symbol) => /^\p{S}/u.test(symbol) && /\p{S}$/u.test(symbol);
		let sample = CURRENCIES.find((code) => out.currencyDigits[code] === 2 && isSymbolic(edgeSymbol(code, "symbol")));
		let symbolDisplay = "symbol";
		if (!sample) {
			sample = CURRENCIES.find(
				(code) => out.currencyDigits[code] === 2 && isSymbolic(edgeSymbol(code, "narrowSymbol"))
			);
			symbolDisplay = "narrowSymbol";
		}
		sample ??= "USD";
		const usdSymbol = edgeSymbol(sample, symbolDisplay);
		for (const display of ["symbol", "code", "name", "narrowSymbol"]) {
			const make = (options) =>
				new Intl.NumberFormat(locale, {
					style: "currency",
					currency: sample,
					currencyDisplay: display === "symbol" ? symbolDisplay : display,
					...options,
				});
			const opts = { mapCurrency: display === "name", symbol: usdSymbol };
			d.currency[display] = {
				pos: templateOf(make().formatToParts(1234.5), opts),
				neg: templateOf(make().formatToParts(-1234.5), opts),
				plus: templateOf(make({ signDisplay: "always" }).formatToParts(1234.5), opts),
			};
		}
		const currencyParts = new Intl.NumberFormat(locale, {
			style: "currency",
			currency: sample,
			currencyDisplay: symbolDisplay,
			useGrouping: true,
		}).formatToParts(-1234567.891);
		d.currency.decimal = currencyParts.find((p) => p.type === "decimal").value;
		d.currency.group = currencyParts.find((p) => p.type === "group").value;
		// A no-break space ICU put between a code and the digits by its currency spacing rule is left to the run time,
		// which does not add it before "NaN" or "∞"; one that is part of the locale's own pattern stays.
		for (const display of ["code"]) {
			const spaced = /\{c\}\u00a0\{n\}|\{n\}\u00a0\{c\}/;
			const plain = d.currency.symbol;
			for (const key of ["pos", "neg", "plus"]) {
				if (spaced.test(d.currency[display][key]) && !spaced.test(plain[key]))
					d.currency[display][key] = d.currency[display][key]
						.replace("{c}\u00a0{n}", "{c}{n}")
						.replace("{n}\u00a0{c}", "{n}{c}");
			}
		}
		// Compact notation wraps the currency around the whole compact number, and may put it on the other side.
		d.currency.compact = {};
		for (const display of ["symbol", "code", "narrowSymbol"]) {
			const compactTemplate = (options, value) => {
				const parts = new Intl.NumberFormat(locale, {
					style: "currency",
					currency: sample,
					currencyDisplay: display === "symbol" ? symbolDisplay : display,
					notation: "compact",
					...options,
				}).formatToParts(value);
				const numeric = ["integer", "group", "decimal", "fraction", "compact"];
				const first = parts.findIndex((p) => numeric.includes(p.type));
				const last = parts.findLastIndex((p) => numeric.includes(p.type));
				return parts
					.map((p, i) =>
						i === first
							? "{n}"
							: i > first && i <= last
								? ""
								: p.type === "currency"
									? "{c}"
									: p.type === "minusSign"
										? "{-}"
										: p.type === "plusSign"
											? "{+}"
											: p.value
					)
					.join("");
			};
			d.currency.compact[display] = {
				pos: compactTemplate({}, 1234567),
				neg: compactTemplate({}, -1234567),
				plus: compactTemplate({ signDisplay: "always" }, 1234567),
				accounting: compactTemplate({ currencySign: "accounting" }, -1234567),
				accountingPlus: compactTemplate({ currencySign: "accounting", signDisplay: "always" }, 1234567),
			};
		}
		const acct = new Intl.NumberFormat(locale, {
			style: "currency",
			currency: sample,
			currencyDisplay: symbolDisplay,
			currencySign: "accounting",
		});
		d.currency.accounting = templateOf(acct.formatToParts(-1234.5));
		d.currency.accountingPlus = templateOf(
			new Intl.NumberFormat(locale, {
				style: "currency",
				currency: sample,
				currencyDisplay: symbolDisplay,
				currencySign: "accounting",
				signDisplay: "always",
			}).formatToParts(1234.5)
		);
		const accountingSizes = groupSizes(acct);
		d.currency.accountingGroupSizes = accountingSizes.join() === d.groupSizes.join() ? null : accountingSizes;
		const samples = categorySamples(locale);
		d.symbols = {};
		for (const code of CURRENCIES) {
			const row = { c: {} };
			const first = (display, value = 1234.5) =>
				new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: display })
					.formatToParts(value)
					.find((p) => p.type === "currency")?.value ?? code;
			row.s = first("symbol");
			row.w = first("narrowSymbol");
			const digits = out.currencyDigits[code];
			const shownRules = new Intl.PluralRules(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
			const named = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "name" });
			for (const n of [...Array.from({ length: 201 }, (_, i) => i), 0.5, 1.5, 2.5, 5.5]) {
				const category = shownRules.select(n);
				row.c[category] ??= named
					.formatToParts(n)
					.filter((p) => p.type === "currency")
					.pop().value;
			}
			// Without fraction digits (compact notation) a whole number can be "one".
			const wholeRules = new Intl.PluralRules(locale);
			const whole = new Intl.NumberFormat(locale, {
				style: "currency",
				currency: code,
				currencyDisplay: "name",
				minimumFractionDigits: 0,
				maximumFractionDigits: 0,
			});
			for (const n of Array.from({ length: 201 }, (_, i) => i)) {
				row.w0 ??= {};
				row.w0[wholeRules.select(n)] ??= whole
					.formatToParts(n)
					.filter((p) => p.type === "currency")
					.pop().value;
			}
			d.symbols[code] = row;
		}
		// Compact notation: per power of ten, the power removed; per removed power and plural category, a pattern.
		d.compact = { short: { remove: {}, forms: {} }, long: { remove: {}, forms: {} } };
		const rules = new Intl.PluralRules(locale);
		for (const display of ["short", "long"]) {
			const f = new Intl.NumberFormat(locale, { notation: "compact", compactDisplay: display });
			const table = d.compact[display];
			for (let k = 3; k <= 21; k++) {
				const ps = f.formatToParts(1.234 * 10 ** k);
				const shown = ps
					.filter((p) => p.type === "integer")
					.map((p) => p.value)
					.join("")
					.replace(/\D/g, "").length;
				table.remove[k] = k - (shown - 1);
			}
			for (const [k, removed] of Object.entries(table.remove)) {
				table.forms[removed] ??= {};
				for (const c of [1, 1.2, 1.5, 2, 3, 4, 5, 6, 8, 9.5, 10, 11, 12, 15, 21, 22, 25, 100, 101, 111, 125, 999]) {
					const value = c * 10 ** Number(k);
					if (Math.floor(Math.log10(value)) !== Number(k)) continue;
					const ps = f.formatToParts(value);
					const number = ps
						.filter((p) => p.type === "integer" || p.type === "decimal" || p.type === "fraction")
						.map((p) => p.value)
						.join("");
					const numeric = ps.some((p) => p.type === "integer") ? Number(number.replace(d.decimal, ".")) : 1;
					const template = numberTemplate(ps);
					const key = numeric === 1 ? "=1" : rules.select(numeric);
					table.forms[removed][key] ??= template;
				}
				const forms = table.forms[removed];
				if (forms["=1"] !== undefined && forms["=1"] === forms.one) delete forms["=1"];
			}
		}
		// Units.
		d.units = {};
		for (const unit of UNITS) {
			d.units[unit] = {};
			for (const style of ["short", "long", "narrow"]) {
				const f = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: style });
				d.units[unit][style] = {};
				for (const [category, n] of Object.entries(samples)) {
					d.units[unit][style][category] = numberTemplate(f.formatToParts(n));
				}
			}
		}
		d.rangeSep = {};
		for (const style of ["decimal", "percent", "currency", "unit"]) {
			const f = new Intl.NumberFormat(locale, { style, currency: "USD", unit: "kilometer" });
			d.rangeSep[style] =
				f.formatRangeToParts(3, 5).find((p) => p.type === "literal" && p.source === "shared")?.value ?? "–";
		}
		return d;
	}

	// ---- date data ---------------------------------------------------------------------------------------------------
	const DATE_STYLES = ["full", "long", "medium", "short"];
	const monthsOf = (locale, width, day) =>
		Array.from(
			{ length: 12 },
			(_, m) =>
				new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: width, ...(day ? { day: "numeric" } : {}) })
					.formatToParts(new Date(Date.UTC(2024, m, 15)))
					.find((p) => p.type === "month").value
		);
	const weekdaysOf = (locale, width, withDate) =>
		Array.from(
			{ length: 7 },
			(_, i) =>
				new Intl.DateTimeFormat(locale, {
					timeZone: "UTC",
					weekday: width,
					...(withDate ? { day: "numeric", month: "numeric" } : {}),
				})
					.formatToParts(new Date(Date.UTC(2024, 0, 7 + i)))
					.find((p) => p.type === "weekday").value
		);

	/** The values one date field takes over twelve months (or seven weekdays) in a given pattern: what identifies its style. */
	function cycleOf(locale, opts, names, type, count) {
		const f = new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts });
		const values = [];
		for (let i = 0; i < count; i++) {
			const date =
				type === "month" ? new Date(Date.UTC(2024, i, 3, 5, 9, 4)) : new Date(Date.UTC(2024, 0, 7 + i, 5, 9, 4));
			values.push(f.formatToParts(date).find((p) => p.type === type)?.value);
		}
		void names;
		return values;
	}
	function tokenize(locale, opts, names) {
		if (process.env.DEBUG_INTL === "2") process.stderr.write(`\n<${locale} ${JSON.stringify(opts)}>`);
		const f = new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts });
		const tokens = [];
		const numbers = f.formatToParts(SAMPLE_NUMBERS);
		for (const [index, p] of f.formatToParts(SAMPLE).entries()) {
			let style;
			const v = p.value;
			const n = numbers[index];
			switch (p.type) {
				case "literal":
					tokens.push(v);
					continue;
				case "year":
					style = v.length === 2 ? "2-digit" : "numeric";
					break;
				case "month": {
					if (/^\d+$/.test(n.value)) style = n.value.length === 1 ? "numeric" : "2-digit";
					else {
						const values = cycleOf(locale, opts, names, "month", 12);
						const order =
							opts.month === "short"
								? ["short", "short-standalone", "long", "long-standalone", "narrow", "narrow-standalone"]
								: opts.month === "narrow"
									? ["narrow", "narrow-standalone", "short", "long"]
									: ["long", "long-standalone", "short", "short-standalone", "narrow", "narrow-standalone"];
						style = order.find((s) => names.months[s].every((m, i) => m === values[i]));
						if (!style) throw new Error(`unknown month ${v} in ${locale} ${JSON.stringify(opts)}`);
					}
					break;
				}
				case "day":
					style = v.length === 1 ? "numeric" : "2-digit";
					break;
				case "weekday": {
					const values = cycleOf(locale, opts, names, "weekday", 7);
					const order =
						opts.weekday === "short"
							? ["short", "short-format", "long", "long-format", "narrow", "narrow-format"]
							: opts.weekday === "narrow"
								? ["narrow", "narrow-format", "short", "long"]
								: ["long", "long-format", "short", "short-format", "narrow", "narrow-format"];
					style = order.find((s) => names.weekdays[s].every((w, i) => w === values[i]));
					if (!style) throw new Error(`unknown weekday ${v} in ${locale} ${JSON.stringify(opts)}`);
					break;
				}
				case "hour":
					style = v.length === 1 ? "numeric" : "2-digit";
					break;
				case "minute":
					style = v.length === 1 ? "numeric" : "2-digit";
					break;
				case "second":
					style = v.length === 1 ? "numeric" : "2-digit";
					break;
				case "dayPeriod": {
					if (opts.dayPeriod) style = `flex-${opts.dayPeriod}`;
					else if (v === names.dayPeriods[0] || v === names.dayPeriods[1]) style = "short";
					else {
						// Some patterns (Chinese, Hindi) name the part of the day ("evening") instead of AM and PM.
						const width = ["short", "long", "narrow"].find((w) => names.flexible[w][SAMPLE.getUTCHours()] === v);
						style = width ? `flex-${width}` : "short";
					}
					break;
				}
				case "era":
					style = opts.era ?? "short";
					break;
				case "timeZoneName":
					style = opts.timeZoneName ?? (opts.timeStyle === "full" ? "long" : "short");
					break;
				case "fractionalSecond":
					style = String(v.length);
					break;
				default:
					style = null;
			}
			tokens.push([p.type, style]);
		}
		const merged = [];
		for (const t of tokens) {
			if (typeof t === "string" && typeof merged[merged.length - 1] === "string") merged[merged.length - 1] += t;
			else merged.push(t);
		}
		return merged;
	}
	// Patterns are stored as strings: literal text, and each field as U+E000, a letter for its type and one for its style.
	const TYPE_CODES = {
		year: "y",
		month: "M",
		day: "d",
		weekday: "E",
		hour: "h",
		minute: "m",
		second: "s",
		dayPeriod: "a",
		era: "G",
		timeZoneName: "z",
		fractionalSecond: "S",
	};
	const STYLE_CODES = {
		numeric: "n",
		"2-digit": "D",
		long: "L",
		short: "S",
		narrow: "N",
		"long-standalone": "l",
		"short-standalone": "t",
		"narrow-standalone": "a",
		"long-format": "F",
		"short-format": "f",
		"narrow-format": "g",
		"flex-long": "X",
		"flex-short": "Y",
		"flex-narrow": "Z",
		shortOffset: "o",
		longOffset: "O",
		shortGeneric: "p",
		longGeneric: "q",
		1: "1",
		2: "2",
		3: "3",
	};
	const encodePattern = (tokens) =>
		tokens
			.map((t) =>
				typeof t === "string"
					? t
					: `\uE000${TYPE_CODES[t[0]]}${
							t[1] === null
								? "-"
								: (STYLE_CODES[t[1]] ??
									(() => {
										throw new Error(`style ${t[1]}`);
									})())
						}`
			)
			.join("");

	function dateData(locale) {
		const d = { months: {}, weekdays: {}, dayPeriods: {}, eras: {}, patterns: {}, styles: {}, glue: {}, flexible: {} };
		for (const width of ["long", "short", "narrow"]) {
			d.months[width] = monthsOf(locale, width, true);
			d.months[`${width}-standalone`] = monthsOf(locale, width, false);
			d.weekdays[width] = weekdaysOf(locale, width, false);
			d.weekdays[`${width}-format`] = weekdaysOf(locale, width, true);
			d.eras[width] = [-100, 2024].map(
				(year) =>
					new Intl.DateTimeFormat(locale, { timeZone: "UTC", era: width, year: "numeric" })
						.formatToParts(new Date(Date.UTC(year, 0, 15)))
						.find((p) => p.type === "era").value
			);
		}
		d.dayPeriods = ["am", "pm"].map(
			(_, i) =>
				new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", hour12: true })
					.formatToParts(new Date(Date.UTC(2024, 0, 15, i ? 15 : 3)))
					.find((p) => p.type === "dayPeriod")?.value ?? (i ? "PM" : "AM")
		);
		for (const width of ["long", "short", "narrow"]) {
			d.flexible[width] = Array.from(
				{ length: 24 },
				(_, h) =>
					new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", hour12: true, dayPeriod: width })
						.formatToParts(new Date(Date.UTC(2024, 0, 15, h)))
						.find((p) => p.type === "dayPeriod")?.value ?? ""
			);
		}
		const cycle = (hour12) => new Intl.DateTimeFormat(locale, { hour: "numeric", hour12 }).resolvedOptions().hourCycle;
		d.hourCycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
		d.hc12 = cycle(true);
		d.hc24 = cycle(false);
		const info = new Intl.Locale(locale);
		d.firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 7;

		const yy = [null, "numeric", "2-digit"];
		const mm = [null, "numeric", "2-digit", "long", "short", "narrow"];
		const dd = [null, "numeric", "2-digit"];
		const ww = [null, "long", "short", "narrow"];
		for (const y of yy)
			for (const m of mm)
				for (const day of dd)
					for (const w of ww) {
						if (!y && !m && !day && !w) continue;
						const opts = {};
						if (y) opts.year = y;
						if (m) opts.month = m;
						if (day) opts.day = day;
						if (w) opts.weekday = w;
						d.patterns[`D|${y ?? ""}|${m ?? ""}|${day ?? ""}|${w ?? ""}`] = tokenize(locale, opts, d);
					}
		for (const c of ["h11", "h12", "h23", "h24"]) {
			for (const h of ["numeric", "2-digit"])
				for (const min of [null, "2-digit", "numeric"])
					for (const sec of [null, "2-digit", "numeric"]) {
						const opts = { hour: h, hourCycle: c };
						if (min) opts.minute = min;
						if (sec) opts.second = sec;
						d.patterns[`T|${c}|${h}|${min ?? ""}|${sec ?? ""}`] = tokenize(locale, opts, d);
					}
			for (const [min, sec] of [
				["2-digit", null],
				["numeric", null],
				[null, "2-digit"],
				[null, "numeric"],
				["2-digit", "2-digit"],
				["numeric", "numeric"],
				["2-digit", "numeric"],
				["numeric", "2-digit"],
			]) {
				const opts = { hourCycle: c };
				if (min) opts.minute = min;
				if (sec) opts.second = sec;
				d.patterns[`T|${c}||${min ?? ""}|${sec ?? ""}`] = tokenize(locale, opts, d);
			}
			// A weekday next to a time is one skeleton in ICU's data ("E h:mm a"), not a date and a time joined.
			for (const w of ["long", "short", "narrow"])
				for (const h of ["numeric", "2-digit"])
					for (const min of [null, "2-digit", "numeric"])
						for (const sec of [null, "2-digit", "numeric"]) {
							const opts = { weekday: w, hour: h, hourCycle: c };
							if (min) opts.minute = min;
							if (sec) opts.second = sec;
							d.patterns[`W|${c}|${w}|${h}|${min ?? ""}|${sec ?? ""}`] = tokenize(locale, opts, d);
						}
			// Flexible day periods, with an hour.
			for (const width of ["long", "short", "narrow"]) {
				d.patterns[`T|${c}|numeric||dp:${width}`] = tokenize(
					locale,
					{ hour: "numeric", hourCycle: c, dayPeriod: width },
					d
				);
				d.patterns[`T|${c}|numeric|2-digit|dp:${width}`] = tokenize(
					locale,
					{ hour: "numeric", minute: "2-digit", hourCycle: c, dayPeriod: width },
					d
				);
			}
			// A zone name after the time.
			for (const tz of ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"]) {
				for (const h of ["numeric", "2-digit"])
					for (const [min, sec] of [
						[null, null],
						["2-digit", null],
						["numeric", null],
						["2-digit", "2-digit"],
					]) {
						const opts = { hour: h, hourCycle: c, timeZoneName: tz };
						if (min) opts.minute = min;
						if (sec) opts.second = sec;
						d.patterns[`Z|${tz}|${c}|${h}|${min ?? ""}|${sec ?? ""}`] = tokenize(locale, opts, d);
					}
			}
		}
		for (const width of ["long", "short", "narrow"])
			d.patterns[`P|${width}`] = tokenize(locale, { dayPeriod: width }, d);
		for (const era of ["long", "short", "narrow"])
			for (const y of ["numeric", "2-digit"])
				for (const m of [null, "numeric", "long", "short"])
					for (const day of [null, "numeric"])
						for (const w of [null, "long"]) {
							// (Node 26's ICU aborts on era + numeric date + weekday in de-CH.)
							if (w && m !== "long") continue;
							const opts = { era, year: y };
							if (m) opts.month = m;
							if (day) opts.day = day;
							if (w) opts.weekday = w;
							d.patterns[`E|${era}|${y}|${m ?? ""}|${day ?? ""}|${w ?? ""}`] = tokenize(locale, opts, d);
						}
		for (const tz of ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"]) {
			d.patterns[`Z|${tz}|D|numeric|numeric|numeric|`] = tokenize(
				locale,
				{ year: "numeric", month: "numeric", day: "numeric", timeZoneName: tz },
				d
			);
			d.patterns[`Z|${tz}|D|numeric|long|numeric|`] = tokenize(
				locale,
				{ year: "numeric", month: "long", day: "numeric", timeZoneName: tz },
				d
			);
			d.patterns[`Z|${tz}|D|numeric|long|numeric|long`] = tokenize(
				locale,
				{ year: "numeric", month: "long", day: "numeric", weekday: "long", timeZoneName: tz },
				d
			);
			d.patterns[`Z|${tz}|D|numeric|short|numeric|`] = tokenize(
				locale,
				{ year: "numeric", month: "short", day: "numeric", timeZoneName: tz },
				d
			);
			d.patterns[`Z|${tz}|Z`] = tokenize(locale, { timeZoneName: tz }, d);
		}
		for (const dateStyle of [...DATE_STYLES, null]) {
			for (const timeStyle of [...DATE_STYLES, null]) {
				if (!dateStyle && !timeStyle) continue;
				const key = `${dateStyle ?? ""}|${timeStyle ?? ""}`;
				d.styles[key] = {};
				for (const cycle of timeStyle ? ["h11", "h12", "h23", "h24"] : ["h12"]) {
					const opts = { hourCycle: cycle };
					if (dateStyle) opts.dateStyle = dateStyle;
					if (timeStyle) opts.timeStyle = timeStyle;
					if (!timeStyle) delete opts.hourCycle;
					d.styles[key][cycle] = tokenize(locale, opts, d);
				}
			}
		}
		// How a date and a time join: the text between them, by the width of the date part.
		const glueClasses = {
			full: { weekday: "long", year: "numeric", month: "long", day: "numeric" },
			long: { year: "numeric", month: "long", day: "numeric" },
			medium: { year: "numeric", month: "short", day: "numeric" },
			short: { year: "numeric", month: "numeric", day: "numeric" },
		};
		for (const [name, dateOpts] of Object.entries(glueClasses)) {
			d.glue[name] = {};
			for (const hour12 of [true, false]) {
				const tokens = tokenize(locale, { ...dateOpts, hour: "numeric", minute: "2-digit", hour12 }, d);
				const isTime = (t) => Array.isArray(t) && ["hour", "minute", "second", "dayPeriod"].includes(t[0]);
				const firstTime = tokens.findIndex(isTime);
				const lastDate = tokens.findLastIndex((t) => Array.isArray(t) && !isTime(t) && t[0] !== "timeZoneName");
				if (firstTime < lastDate) throw new Error(`${locale}: date and time interleave`);
				const between = tokens
					.slice(lastDate + 1, firstTime)
					.filter((t) => typeof t === "string")
					.join("");
				// The date pattern alone may end in text of its own (Russian "г.", Korean "."); the glue is what comes after it.
				const alone = tokenize(locale, dateOpts, d);
				const trailing = typeof alone[alone.length - 1] === "string" ? alone[alone.length - 1] : "";
				d.glue[name][hour12 ? "h12" : "h23"] = between.startsWith(trailing) ? between.slice(trailing.length) : between;
				// Time before date is not something the 20 locales do; fail loudly if it appears.
				if (tokens.findIndex((t) => Array.isArray(t) && ["year", "month", "day", "weekday"].includes(t[0])) > firstTime)
					throw new Error(`${locale}: time comes before the date`);
			}
		}
		d.rangeSep = new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" })
			.formatRangeToParts(Date.UTC(2020, 0, 1), Date.UTC(2024, 5, 15))
			.find((p) => p.type === "literal" && p.source === "shared").value;
		// Store each distinct pattern once.
		const table = [];
		const index = new Map();
		const put = (tokens) => {
			const encoded = encodePattern(tokens);
			if (!index.has(encoded)) {
				index.set(encoded, table.length);
				table.push(encoded);
			}
			return index.get(encoded);
		};
		const keys = {};
		for (const [key, tokens] of Object.entries(d.patterns)) keys[key] = put(tokens);
		const styles = {};
		for (const [key, byCycle] of Object.entries(d.styles))
			styles[key] = Object.fromEntries(Object.entries(byCycle).map(([cycle, tokens]) => [cycle, put(tokens)]));
		d.patterns = keys;
		d.styles = styles;
		d.table = table;
		return d;
	}

	// GMT offset strings per locale.
	function gmtData(locale) {
		const sample = (zoneName, style, at) =>
			new Intl.DateTimeFormat(locale, { timeZone: zoneName, timeZoneName: style, hour: "numeric" })
				.formatToParts(at)
				.find((p) => p.type === "timeZoneName").value;
		const winter = new Date(Date.UTC(2024, 0, 15, 12));
		const plus = sample("Asia/Kolkata", "shortOffset", winter);
		const minus = sample("America/St_Johns", "shortOffset", winter);
		const p = /^(.*?)([+\-−])(\d+)(\D)(\d+)$/.exec(plus);
		const m = /^(.*?)([+\-−])(\d+)(\D)(\d+)$/.exec(minus);
		if (!p || !m) throw new Error(`cannot parse GMT format of ${locale}: ${plus} ${minus}`);
		const zero = sample("Etc/GMT", "shortOffset", winter);
		const long = sample("Asia/Kolkata", "longOffset", winter);
		if (long !== `${p[1]}${p[2]}05${p[4]}30`) throw new Error(`unexpected long GMT format ${long} for ${locale}`);
		const tail = sample("Asia/Tokyo", "shortOffset", winter);
		if (tail !== `${p[1]}${p[2]}9`) throw new Error(`unexpected hour-only GMT format ${tail} for ${locale}`);
		return { prefix: p[1], plus: p[2], minus: m[2], sep: p[4], zero };
	}

	// Localized zone names, deduplicated: a table of name tuples, and for each zone the tuple it uses.
	function zoneNameData(locale) {
		const tuples = [];
		const index = new Map();
		const zones = {};
		const nameOf = (zoneName, style, at) =>
			new Intl.DateTimeFormat(locale, { timeZone: zoneName, timeZoneName: style, hour: "numeric" })
				.formatToParts(at)
				.find((p) => p.type === "timeZoneName").value;
		const isOffset = (s) => /^(GMT|UTC|[^\d\s]{2,5})[+\-\u2212]\d/.test(s);
		for (const name of Object.keys(out.zones)) {
			const record = out.zones[name];
			const bounds = [NAME_FROM, ...(record.m ?? []).map((t) => t * 1000), NAME_TO];
			const indexes = [];
			for (let k = 0; k + 1 < bounds.length; k++) {
				const { std, dst, flat } = seasonsIn(name, record, bounds[k], bounds[k + 1]);
				const row = [];
				for (const [style, at] of [
					["short", std],
					["short", dst],
					["long", std],
					["long", dst],
					["shortGeneric", std],
					["shortGeneric", dst],
					["longGeneric", std],
					["longGeneric", dst],
					["shortGeneric", flat],
					["longGeneric", flat],
				]) {
					const value = nameOf(name, style, new Date(at));
					row.push(isOffset(value) ? "" : value);
				}
				const key = row.join("\u0001");
				if (!index.has(key)) {
					index.set(key, tuples.length);
					tuples.push(row);
				}
				indexes.push(index.get(key));
			}
			zones[name] = indexes.length === 1 ? indexes[0] : indexes;
		}
		return { tuples, zones };
	}

	// ---- relative time and lists ---------------------------------------------------------------------------------------
	function relativeData(locale) {
		const r = {};
		const samples = categorySamples(locale);
		for (const style of ["long", "short", "narrow"]) {
			r[style] = {};
			for (const unit of ["year", "quarter", "month", "week", "day", "hour", "minute", "second"]) {
				const always = new Intl.RelativeTimeFormat(locale, { style, numeric: "always" });
				const auto = new Intl.RelativeTimeFormat(locale, { style, numeric: "auto" });
				const row = { past: {}, future: {}, auto: {} };
				for (const [cat, n] of Object.entries(samples)) {
					const tpl = (v) =>
						always
							.formatToParts(v, unit)
							.map((p) =>
								p.type === "integer" ? "{n}" : ["group", "decimal", "fraction"].includes(p.type) ? "" : p.value
							)
							.join("");
					row.future[cat] = tpl(n);
					row.past[cat] = tpl(-n);
				}
				for (const v of [-2, -1, 0, 1, 2]) {
					const text = auto.format(v, unit);
					if (text !== always.format(v, unit)) row.auto[v] = text;
				}
				r[style][unit] = row;
			}
		}
		return r;
	}
	function listData(locale) {
		const l = {};
		for (const type of ["conjunction", "disjunction", "unit"]) {
			l[type] = {};
			for (const style of ["long", "short", "narrow"]) {
				const f = new Intl.ListFormat(locale, { type, style });
				l[type][style] = {
					two: f.format(["{a}", "{b}"]),
					three: f.format(["{a}", "{b}", "{c}"]),
					four: f.format(["{a}", "{b}", "{c}", "{d}"]),
				};
			}
		}
		return l;
	}
	function pluralData(locale) {
		return {
			cardinal: new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
			ordinal: new Intl.PluralRules(locale, { type: "ordinal" }).resolvedOptions().pluralCategories,
		};
	}

	// ---- display names ---------------------------------------------------------------------------------------------------
	const letters = "abcdefghijklmnopqrstuvwxyz";
	const pairs = [...letters].flatMap((a) => [...letters].map((b) => a + b));
	const triples = [...letters].flatMap((a) => [...letters].flatMap((b) => [...letters].map((c) => a + b + c)));
	const REGIONS = [
		...pairs.map((c) => c.toUpperCase()),
		...Array.from({ length: 999 }, (_, i) => String(i + 1).padStart(3, "0")),
	];
	const validRegions = REGIONS.filter(
		(c) => new Intl.DisplayNames("en", { type: "region", fallback: "none" }).of(c) !== undefined
	);
	const validLanguages = [...pairs, ...triples].filter(
		(c) => new Intl.DisplayNames("en", { type: "language", fallback: "none" }).of(c) !== undefined
	);
	const validCurrencies = triples
		.map((c) => c.toUpperCase())
		.filter((c) => new Intl.DisplayNames("en", { type: "currency", fallback: "none" }).of(c) !== undefined);
	const SCRIPTS =
		"Adlm Arab Armn Beng Bopo Brai Cyrl Deva Ethi Geor Grek Gujr Guru Hang Hani Hans Hant Hebr Hira Jpan Kana Khmr Knda Kore Laoo Latn Mlym Mong Mymr Orya Sinh Taml Telu Thaa Thai Tibt Zyyy Zzzz".split(
			" "
		);
	const DIALECTS = [];
	for (const language of [
		"en",
		"de",
		"fr",
		"es",
		"pt",
		"zh",
		"nl",
		"it",
		"sv",
		"pl",
		"ru",
		"tr",
		"ja",
		"ko",
		"ar",
		"hi",
		"he",
		"sr",
		"hr",
		"bs",
		"ro",
		"mo",
		"sw",
		"nds",
		"fa",
		"ps",
		"ur",
		"pa",
		"ms",
		"ln",
		"lu",
	]) {
		for (const region of validRegions) DIALECTS.push(`${language}-${region}`);
		for (const script of SCRIPTS) DIALECTS.push(`${language}-${script}`);
	}
	const displayFor = (locale) => {
		const region = new Intl.DisplayNames(locale, { type: "region", fallback: "none" });
		const language = new Intl.DisplayNames(locale, { type: "language", fallback: "none" });
		const currency = new Intl.DisplayNames(locale, { type: "currency", fallback: "none" });
		const script = new Intl.DisplayNames(locale, { type: "script", fallback: "none" });
		const dialect = new Intl.DisplayNames(locale, { type: "language", fallback: "none", languageDisplay: "dialect" });
		const names = { region: {}, language: {}, currency: {}, script: {}, dialect: {} };
		for (const c of validRegions) names.region[c] = region.of(c);
		for (const c of validLanguages) names.language[c] = language.of(c);
		for (const c of validCurrencies) names.currency[c] = currency.of(c);
		for (const c of SCRIPTS) names.script[c] = script.of(c);
		for (const c of DIALECTS) {
			const v = dialect.of(c);
			// Only names ICU gives as one phrase ("American English"); a composition is built at run time.
			if (v !== undefined && !/[()\uFF08\uFF09]/.test(v)) names.dialect[c] = v;
		}
		for (const style of ["short", "narrow"]) {
			const styled = new Intl.DisplayNames(locale, {
				type: "language",
				fallback: "none",
				languageDisplay: "dialect",
				style,
			});
			const table = {};
			for (const c of DIALECTS) {
				const v = styled.of(c);
				if (v !== undefined && !/[()\uFF08\uFF09]/.test(v) && v !== names.dialect[c]) table[c] = v;
			}
			if (Object.keys(table).length) names[`dialect:${style}`] = table;
		}
		// How this locale writes "English (Latin, United States)": what opens the qualifiers, separates them and closes them.
		const standard = new Intl.DisplayNames(locale, { type: "language", languageDisplay: "standard" });
		const [en, latin, us] = [language.of("en"), script.of("Latn"), region.of("US")];
		const composed = standard.of("en-Latn-US");
		const iLatin = composed.indexOf(latin);
		const iUs = composed.indexOf(us);
		names.compose = {
			open: composed.slice(en.length, iLatin),
			sep: composed.slice(iLatin + latin.length, iUs),
			close: composed.slice(iUs + us.length),
		};
		// Short and narrow spellings, where they differ.
		for (const type of ["region", "currency", "language", "script"]) {
			for (const style of ["short", "narrow"]) {
				const f = new Intl.DisplayNames(locale, { type, style, fallback: "none" });
				const table = {};
				for (const [code, long] of Object.entries(names[type])) {
					const v = f.of(code);
					if (v !== undefined && v !== long) table[code] = v;
				}
				if (Object.keys(table).length) names[`${type}:${style}`] = table;
			}
		}
		names.calendar = {};
		for (const c of Intl.supportedValuesOf("calendar"))
			names.calendar[c] = new Intl.DisplayNames(locale, { type: "calendar", fallback: "none" }).of(c);
		names.dateTimeField = {};
		for (const style of ["long", "short", "narrow"]) {
			const f = new Intl.DisplayNames(locale, { type: "dateTimeField", style });
			names.dateTimeField[style] = Object.fromEntries(
				[
					"era",
					"year",
					"quarter",
					"month",
					"weekOfYear",
					"weekday",
					"day",
					"dayPeriod",
					"hour",
					"minute",
					"second",
					"timeZoneName",
				].map((k) => [k, f.of(k)])
			);
		}
		return names;
	};

	// ---- likely subtags ------------------------------------------------------------------------------------------------------
	for (const language of [...validLanguages, "und"]) {
		const max = new Intl.Locale(language).maximize().toString();
		out.likely[language] = max;
	}
	out.likelyScript = {};
	for (const language of Object.keys(out.likely)) {
		if (language.length > 2 && !["fil", "haw", "yue", "ast", "ckb"].includes(language)) continue;
		for (const script of SCRIPTS) {
			const max = new Intl.Locale(`${language}-${script}`).maximize().toString();
			const expected = `${language}-${script}-${out.likely[language].split("-")[2]}`;
			if (max !== expected) out.likelyScript[`${language}-${script}`] = max;
		}
		for (const region of [
			"TW",
			"HK",
			"MO",
			"CN",
			"SG",
			"US",
			"GB",
			"PT",
			"BR",
			"ME",
			"BA",
			"RS",
			"IN",
			"PK",
			"AF",
			"IR",
			"CA",
			"CH",
			"AT",
			"BE",
			"MX",
			"419",
			"ES",
		]) {
			const max = new Intl.Locale(`${language}-${region}`).maximize().toString();
			const expected = `${out.likely[language].split("-").slice(0, 2).join("-")}-${region}`;
			if (max !== expected) out.likelyScript[`${language}-${region}`] = max;
		}
	}

	out.supported = {};
	for (const key of ["calendar", "collation", "currency", "numberingSystem", "unit"])
		out.supported[key] = Intl.supportedValuesOf(key);
	out.weekInfo = {};
	for (const region of validRegions.filter((r) => r.length === 2)) {
		try {
			const info = new Intl.Locale(`und-${region}`).getWeekInfo();
			const key = `${info.firstDay}${info.minimalDays}${info.weekend.join("")}`;
			if (key !== "1467")
				out.weekInfo[region] = { firstDay: info.firstDay, minimalDays: info.minimalDays, weekend: info.weekend };
		} catch {
			// no week data
		}
	}

	// ---- collation --------------------------------------------------------------------------------------------------------------
	const { collationData } = require("./gen-intl-collation.js");
	out.collation = collationData(LOCALES);

	for (const locale of LOCALES) {
		const stage = (name, make) => {
			if (process.env.DEBUG_INTL) process.stderr.write(`[${locale}:${name}]`);
			return make(locale);
		};
		out.locales[locale] = {
			number: stage("number", numberData),
			date: stage("date", dateData),
			gmt: stage("gmt", gmtData),
			zoneNames: stage("zoneNames", zoneNameData),
			relative: stage("relative", relativeData),
			list: stage("list", listData),
			plural: stage("plural", pluralData),
			names: stage("names", displayFor),
		};
		process.stderr.write(`${locale} `);
	}

	// ---- output: one shared file, and per locale a file of formats and one of display names --------------------------------------
	const encodeZone = (z) => ({
		i: z.initial,
		t: z.at.map((v, i) => (v - (z.at[i - 1] ?? 0)).toString(36)).join(","),
		o: z.offsets.map((v) => v.toString(36)).join(","),
		d: z.dsts.join(""),
		...(z.rule ? { r: z.rule, f: z.ruleFrom } : {}),
		...(z.m ? { m: z.m } : {}),
	});
	const zones = Object.fromEntries(Object.entries(out.zones).map(([name, z]) => [name, encodeZone(z)]));
	const dir = path.join(__dirname, "../quickjs/runtime");
	for (const file of fs.readdirSync(dir))
		if (/^intl-(names-)?[a-z]{2}-([A-Z]{2}|\d{3})\.js$/.test(file)) fs.unlinkSync(path.join(dir, file));
	const { tailoring, han, reorder, ...collation } = out.collation;
	const shared = {
		version: out.version,
		tags: LOCALES,
		currencyDigits: out.currencyDigits,
		zones,
		links: out.links,
		zoneList: out.zoneList,
		likely: out.likely,
		likelyScript: out.likelyScript,
		supported: out.supported,
		weekInfo: out.weekInfo,
		collation,
	};
	const banner = `/* Generated by tools/gen-intl-data.js from ICU ${process.versions.icu}: do not edit. */\n`;
	fs.writeFileSync(
		path.join(dir, "intl-data.js"),
		`${banner}globalThis.__graak_intl_data = ${JSON.stringify(shared)};\n`
	);
	for (const locale of LOCALES) {
		const { names, ...rest } = out.locales[locale];
		const data = {
			...rest,
			tailoring: tailoring[locale] ?? {},
			...(reorder[locale] ? { reorder: reorder[locale] } : {}),
			...(han[locale] ? { han: han[locale] } : {}),
		};
		fs.writeFileSync(
			path.join(dir, `intl-${locale}.js`),
			`${banner}(globalThis.__graak_intl_locales ??= {})[${JSON.stringify(locale)}] = ${JSON.stringify(data)};\n`
		);
		fs.writeFileSync(
			path.join(dir, `intl-names-${locale}.js`),
			`${banner}(globalThis.__graak_intl_names ??= {})[${JSON.stringify(locale)}] = ${JSON.stringify(names)};\n`
		);
	}
	process.stderr.write("\nwritten\n");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
