// A minimal WebAssembly binary emitter: just enough to assemble the modules our in-browser C-subset
// compiler produces, with no external dependency so it ships in the app (not a multi-MB clang). It
// supports i32 locals/arithmetic, calls to imported functions, a linear memory with data segments,
// and exported functions. Control flow and i64/f64 are intentionally absent until the compiler
// needs them. Function indices are: imported functions first (in addImport order), then defined
// functions (in addFunc order).

const I32 = 0x7f;

export const OP = {
  localGet: 0x20, localSet: 0x21, localTee: 0x22,
  i32Const: 0x41,
  i32Eqz: 0x45, i32Eq: 0x46, i32Ne: 0x47, i32LtS: 0x48, i32GtS: 0x4a, i32LeS: 0x4c, i32GeS: 0x4e,
  i32Add: 0x6a, i32Sub: 0x6b, i32Mul: 0x6c, i32DivS: 0x6d, i32RemS: 0x6f,
  i32And: 0x71, i32Or: 0x72,
  call: 0x10, drop: 0x1a, ret: 0x0f, end: 0x0b,
  block: 0x02, loop: 0x03, if_: 0x04, else_: 0x05, br: 0x0c, brIf: 0x0d,
  globalGet: 0x23, globalSet: 0x24, i32GtU: 0x4b,
  unreachable: 0x00, brTable: 0x0e,
} as const;
export const VOID_BLOCK = 0x40;
export const globalGet = (i: number): number[] => [OP.globalGet, ...uleb(i)];
export const globalSet = (i: number): number[] => [OP.globalSet, ...uleb(i)];

export function uleb(n: number): number[] { const out: number[] = []; let v = n >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; out.push(b); } while (v !== 0); return out; }
export function sleb(n: number): number[] { const out: number[] = []; let more = true; while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false; else b |= 0x80; out.push(b & 0xff); } return out; }

export const i32Const = (n: number): number[] => [OP.i32Const, ...sleb(n | 0)];
export const localGet = (i: number): number[] => [OP.localGet, ...uleb(i)];
export const localSet = (i: number): number[] => [OP.localSet, ...uleb(i)];
export const call = (idx: number): number[] => [OP.call, ...uleb(idx)];

export interface FuncType { params: number[]; results: number[] }
interface ImportEntry { module: string; name: string; type: number }
interface FuncEntry { type: number; locals: number; body: number[]; exportName?: string }
interface DataEntry { offset: number; bytes: number[] }

export class WasmModule {
  private types: FuncType[] = [];
  private imports: ImportEntry[] = [];
  private funcs: FuncEntry[] = [];
  private datas: DataEntry[] = [];
  private globals = 0;   // count of mutable i32 globals, all zero-initialized
  memPages = 1;

  /** Add a mutable i32 global (init 0); returns its index. */
  addGlobal(): number { return this.globals++; }

  typeIdx(params: number[], results: number[]): number {
    const i = this.types.findIndex(t => t.params.length === params.length && t.results.length === results.length && t.params.every((p, k) => p === params[k]) && t.results.every((r, k) => r === results[k]));
    if (i >= 0) return i; this.types.push({ params, results }); return this.types.length - 1;
  }
  /** Declare an imported function; returns its global function index. Call before addFunc. */
  addImport(module: string, name: string, params: number[], results: number[]): number {
    const type = this.typeIdx(params, results); this.imports.push({ module, name, type }); return this.imports.length - 1;
  }
  /** Define a function; returns its global function index. */
  addFunc(params: number[], results: number[], extraLocals: number, body: number[], exportName?: string): number {
    const type = this.typeIdx(params, results); this.funcs.push({ type, locals: extraLocals, body, exportName });
    return this.imports.length + this.funcs.length - 1;
  }
  addData(offset: number, bytes: number[]) { this.datas.push({ offset, bytes }); }

  emit(): Uint8Array {
    const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // \0asm, version 1
    const section = (id: number, payload: number[]) => { if (!payload.length && id !== 0) return; out.push(id, ...uleb(payload.length), ...payload); };
    const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];

    // 1: types
    section(1, vec(this.types.map(t => [0x60, ...uleb(t.params.length), ...t.params, ...uleb(t.results.length), ...t.results])));
    // 2: imports
    const str = (s: string) => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
    section(2, vec(this.imports.map(im => [...str(im.module), ...str(im.name), 0x00, ...uleb(im.type)])));
    // 3: functions
    section(3, vec(this.funcs.map(f => uleb(f.type))));
    // 5: memory (one, min pages, no max)
    section(5, vec([[0x00, ...uleb(this.memPages)]]));
    // 6: globals (mutable i32, init 0)
    if (this.globals > 0) section(6, vec(Array.from({ length: this.globals }, () => [I32, 0x01, OP.i32Const, 0x00, OP.end])));
    // 7: exports (memory + exported funcs)
    const exports: number[][] = [[...str('memory'), 0x02, ...uleb(0)]];
    this.funcs.forEach((f, i) => { if (f.exportName) exports.push([...str(f.exportName), 0x00, ...uleb(this.imports.length + i)]); });
    section(7, vec(exports));
    // 10: code
    section(10, vec(this.funcs.map(f => {
      const locals = f.locals > 0 ? [...uleb(1), ...uleb(f.locals), I32] : [...uleb(0)];
      const body = [...locals, ...f.body, OP.end];
      return [...uleb(body.length), ...body];
    })));
    // 11: data
    section(11, vec(this.datas.map(d => [0x00, OP.i32Const, ...sleb(d.offset), OP.end, ...uleb(d.bytes.length), ...d.bytes])));
    return new Uint8Array(out);
  }
}
export const i32 = I32;
