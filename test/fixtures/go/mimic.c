/*
 * A hand-written stand-in for a Go `-buildmode=c-shared` library, used when the `go` toolchain is not on PATH.
 * It exports the same three C ABI symbols as test/fixtures/go/lib.go (add, greet, freeString) with the same
 * signatures and no C++ name mangling, so test/goFfi.test.ts can prove Graak's Deno.dlopen/FFI path loads and
 * calls a cgo-shaped shared library even where Go itself cannot be installed.
 */
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

EXPORT int add(int a, int b) {
	return a + b;
}

EXPORT char *greet(const char *name) {
	static const char prefix[] = "Hello, ";
	static const char suffix[] = "!";
	size_t len = strlen(prefix) + strlen(name) + strlen(suffix) + 1;
	char *out = malloc(len);
	if (!out) return NULL;
	out[0] = '\0';
	strcat(out, prefix);
	strcat(out, name);
	strcat(out, suffix);
	return out;
}

EXPORT void freeString(char *s) {
	free(s);
}
