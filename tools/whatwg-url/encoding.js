// whatwg-url's encoding helpers without a dependency on TextEncoder/TextDecoder, which the runtime installs after this
// module has been evaluated: plain UTF-8 in both directions, lone surrogates and bad bytes becoming U+FFFD.
function utf8Encode(string) {
	const out = [];
	for (let i = 0; i < string.length; i++) {
		let code = string.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < string.length) {
			const next = string.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			}
		}
		if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
		if (code < 0x80) out.push(code);
		else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
		else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
	}
	return Uint8Array.from(out);
}

function utf8DecodeWithoutBOM(bytes) {
	let out = "";
	let i = 0;
	const n = bytes.length;
	while (i < n) {
		const b = bytes[i];
		let need = 0;
		let code = 0;
		let lower = 0x80;
		let upper = 0xbf;
		if (b < 0x80) {
			out += String.fromCharCode(b);
			i++;
			continue;
		}
		if (b >= 0xc2 && b <= 0xdf) {
			need = 1;
			code = b & 0x1f;
		} else if (b >= 0xe0 && b <= 0xef) {
			need = 2;
			code = b & 0xf;
			if (b === 0xe0) lower = 0xa0;
			if (b === 0xed) upper = 0x9f;
		} else if (b >= 0xf0 && b <= 0xf4) {
			need = 3;
			code = b & 0x7;
			if (b === 0xf0) lower = 0x90;
			if (b === 0xf4) upper = 0x8f;
		} else {
			out += "�";
			i++;
			continue;
		}
		i++;
		let ok = true;
		for (let k = 0; k < need; k++) {
			const c = bytes[i];
			if (c === undefined || c < lower || c > upper) {
				ok = false;
				break;
			}
			lower = 0x80;
			upper = 0xbf;
			code = (code << 6) | (c & 0x3f);
			i++;
		}
		out += ok ? String.fromCodePoint(code) : "�";
	}
	return out;
}

module.exports = { utf8Encode, utf8DecodeWithoutBOM };
