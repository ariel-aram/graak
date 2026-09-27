// A tiny Go library built with `go build -buildmode=c-shared`, to prove Graak's existing Deno.dlopen/FFI path
// (quickjs/runtime/deno-ffi.js on quickjs/native/fg_ffi.c's libffi calls) loads a cgo c-shared export and calls it,
// with no changes to that path: cgo's `-buildmode=c-shared` output is a plain ELF/PE/Mach-O shared library whose
// //export functions are ordinary C ABI symbols (extern "C", no name mangling), exactly like a hand-written .so.
//
// `add` exercises scalar arguments and a scalar return. `greet` and `freeString` exercise a pointer round trip:
// Go allocates the returned C string with C.CString (malloc under the hood), so the caller must free it with a
// function Go also exports, on Go's own allocator; freeing it with the caller's own free() instead is undefined
// behaviour whenever a different allocator is linked in (not on this host, but a caveat worth keeping).
package main

/*
#include <stdlib.h>
*/
import "C"
import "unsafe"

//export add
func add(a, b C.int) C.int {
	return a + b
}

//export greet
func greet(name *C.char) *C.char {
	return C.CString("Hello, " + C.GoString(name) + "!")
}

//export freeString
func freeString(s *C.char) {
	C.free(unsafe.Pointer(s))
}

// go build -buildmode=c-shared needs a main, even though it is never run as a program.
func main() {}
