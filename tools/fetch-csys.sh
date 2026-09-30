#!/bin/sh
# Download the in-browser C toolchain (LLVM wasm-clang; Apache-2.0 / LLVM-exception) into public/csys/.
# ~60MB, NOT committed; the app serves them same-origin as the opt-in C compiler download.
set -e
d="$(dirname "$0")/../public/csys"; mkdir -p "$d"
base="https://binji.github.io/wasm-clang"
curl -sL --retry 3 -o "$d/clang.wasm"  "$base/clang"
curl -sL --retry 3 -o "$d/lld.wasm"    "$base/lld"
curl -sL --retry 3 -o "$d/memfs.wasm"  "$base/memfs"
curl -sL --retry 3 -o "$d/sysroot.tar" "$base/sysroot.tar"
echo "done -> $d"
cp "$(dirname "$0")/../node_modules/binaryen/index.js" "$d/binaryen.mjs"
echo "binaryen -> $d/binaryen.mjs"
