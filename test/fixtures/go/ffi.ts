// Deno FFI against a cgo-shaped C shared library (`add`, `greet`, `freeString`): proves Graak's Deno.dlopen path
// (quickjs/runtime/deno-ffi.js on quickjs/native/fg_ffi.c's libffi calls) loads and calls a library built by
// `go build -buildmode=c-shared`, or a hand-written stand-in exporting the same plain C ABI symbols, with no
// changes needed to the FFI mechanism itself. The library path is passed as the first CLI argument so the same
// script runs unmodified against either library.
const libPath = Deno.args[0];
const lib = Deno.dlopen(libPath, {
	add: { parameters: ["i32", "i32"], result: "i32" },
	greet: { parameters: ["buffer"], result: "pointer" },
	freeString: { parameters: ["pointer"], result: "void" },
});
console.log("add", lib.symbols.add(19, 23));
const enc = new TextEncoder();
const namePtr = lib.symbols.greet(enc.encode("Graak\0"));
console.log("greet", new Deno.UnsafePointerView(namePtr).getCString());
lib.symbols.freeString(namePtr);
console.log("add again", lib.symbols.add(-4, 4));
lib.close();
