// tr46 (IDNA / UTS #46) on demand: its mapping tables are 200 KB, and most host names are plain ASCII, so the real module
// is a separate script (idna-data.js) that is evaluated the first time a name needs it.
function real() {
	if (!globalThis.__graak_tr46) globalThis.__graak_loadData("idna-data.js");
	return globalThis.__graak_tr46;
}

// Letters, digits, dots, hyphens and underscores: mapping only lower-cases them (an "xn--" label needs the tables).
const PLAIN = /^[A-Za-z0-9._-]*$/;
const plain = (domain) => PLAIN.test(domain) && !/(^|\.)xn--/i.test(domain);

module.exports = {
	toASCII(domain, options) {
		if (plain(domain)) return domain.toLowerCase();
		const out = real().toASCII(domain, options);
		// Node.js (ada) keeps a plain-ASCII name whose "xn--" label it cannot decode, so does this.
		if (out === null && PLAIN.test(domain)) return domain.toLowerCase();
		return out;
	},
	toUnicode(domain, options) {
		if (plain(domain)) return { domain: domain.toLowerCase(), error: false };
		return real().toUnicode(domain, options);
	},
};
