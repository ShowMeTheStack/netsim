// Vendored binji wasm-clang harness (Apache-2.0). Minimal typing: the API orchestrates clang -cc1,
// wasm-ld, and running wasm "commands" over an in-memory FS. See src/engine/cc/clang.ts for use.
export const WasmClangAPI: {
  new (opts: {
    readBuffer: (f: string) => Promise<Uint8Array> | Uint8Array;
    compileStreaming: (f: string) => Promise<WebAssembly.Module>;
    hostWrite: (s: string) => void;
    clang?: string; lld?: string; sysroot?: string; memfs?: string;
  }): {
    ready: Promise<void>;
    clangCommonArgs: string[];
    memfs: { addFile: (p: string, c: string) => void; getFileContents: (p: string) => Uint8Array };
    getModule: (name: string) => Promise<WebAssembly.Module>;
    run: (mod: WebAssembly.Module, ...args: string[]) => Promise<unknown>;
  };
};
