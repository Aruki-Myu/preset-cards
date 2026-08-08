@echo off
echo Building WebAssembly module...
cd rust-core
wasm-pack build --target web --out-dir ../wasm
cd ..
echo Build complete.
