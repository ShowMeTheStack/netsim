// nsC: a tiny, real in-browser compiler for a documented subset of C, straight to WebAssembly that
// matches the netsim-posix ABI startWasmProgram() runs. This is NOT full C: v1 compiles a single
// `int main(void)` of straight-line statements (int locals, +-*/%, parentheses, string literals as
// call arguments) calling the non-blocking socket builtins below. It ships in the app with no
// download. Control flow (if/while), blocking calls (connect/recv with the resume state machine),
// and full-libc clang are the next milestones; the emitter and ABI are built to grow into them.
import { WasmModule, OP, VOID_BLOCK, uleb, i32Const, globalGet, globalSet, call, i32 } from './wasm';
import type { CDiagnostic } from '@/shared/cprograms';

const RECV_BUF = 2048, RECV_CAP = 1024;   // where recv()/recvfrom() land in linear memory

// ---------- builtins ----------
// cParams: the C-level arg kinds ('i' int expr, 's' string literal). `special` means custom codegen.
// block: 'poll'  = re-issued on resume (recv/recvfrom), returns -2 when it must wait.
//        'initiate' = issued once then suspends (connect), resume continues past it.
interface Builtin { import: string; params: number[]; results: number[]; cParams: ('i' | 's')[]; result: 'i' | 'v'; prefixConst?: number; special?: 'recvbuf' | 'printbuf' | 'sendbuf'; block?: 'poll' | 'initiate' }
const BUILTINS: Record<string, Builtin> = {
  tcp:      { import: 'sys_socket', params: [i32], results: [i32], cParams: [], result: 'i', prefixConst: 0 },
  udp:      { import: 'sys_socket', params: [i32], results: [i32], cParams: [], result: 'i', prefixConst: 1 },
  bind:     { import: 'sys_bind', params: [i32, i32], results: [i32], cParams: ['i', 'i'], result: 'i' },
  listen:   { import: 'sys_listen', params: [i32], results: [i32], cParams: ['i'], result: 'i' },
  accept:   { import: 'sys_accept', params: [i32], results: [i32], cParams: ['i'], result: 'i', block: 'poll' },
  connect:  { import: 'sys_connect', params: [i32, i32, i32], results: [i32], cParams: ['i', 'i', 'i'], result: 'i', block: 'initiate' },
  send:     { import: 'sys_send', params: [i32, i32, i32], results: [i32], cParams: ['i', 's'], result: 'i' },
  sendbuf:  { import: 'sys_send', params: [i32, i32, i32], results: [i32], cParams: ['i', 'i'], result: 'i', special: 'sendbuf' },
  sendto:   { import: 'sys_sendto', params: [i32, i32, i32, i32, i32], results: [i32], cParams: ['i', 'i', 'i', 's'], result: 'i' },
  recv:     { import: 'sys_recv', params: [i32, i32, i32], results: [i32], cParams: ['i'], result: 'i', special: 'recvbuf', block: 'poll' },
  recvfrom: { import: 'sys_recvfrom', params: [i32, i32, i32], results: [i32], cParams: ['i'], result: 'i', special: 'recvbuf', block: 'poll' },
  print:    { import: 'sys_print', params: [i32, i32], results: [], cParams: ['s'], result: 'v' },
  printbuf: { import: 'sys_print', params: [i32, i32], results: [], cParams: ['i'], result: 'v', special: 'printbuf' },
  close:    { import: 'sys_close', params: [i32], results: [], cParams: ['i'], result: 'v' },
  ip:       { import: 'arg_ip', params: [], results: [i32], cParams: [], result: 'i' },
  port:     { import: 'arg_port', params: [], results: [i32], cParams: [], result: 'i' },
};

// ---------- tokens ----------
type Tok = { k: 'num'; v: number; line: number; col: number } | { k: 'id'; v: string; line: number; col: number } | { k: 'str'; v: string; line: number; col: number } | { k: 'punct'; v: string; line: number; col: number } | { k: 'eof'; line: number; col: number };
class CcError extends Error { constructor(public line: number, public col: number, msg: string) { super(msg); } }

function lex(src: string): Tok[] {
  const toks: Tok[] = []; let i = 0, line = 1, col = 1;
  const peek = () => src[i]; const adv = () => { const c = src[i++]; if (c === '\n') { line++; col = 1; } else col++; return c; };
  while (i < src.length) {
    const c = peek()!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(); continue; }
    if (c === '#' && (col === 1 || toks.length === 0 || src[i - 1] === '\n')) { while (i < src.length && peek() !== '\n') adv(); continue; } // preprocessor line: skip
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && peek() !== '\n') adv(); continue; }
    if (c === '/' && src[i + 1] === '*') { adv(); adv(); while (i < src.length && !(peek() === '*' && src[i + 1] === '/')) adv(); adv(); adv(); continue; }
    const L = line, C = col;
    if (c >= '0' && c <= '9') { let n = ''; while (i < src.length && peek()! >= '0' && peek()! <= '9') n += adv(); toks.push({ k: 'num', v: Number(n), line: L, col: C }); continue; }
    if (/[A-Za-z_]/.test(c)) { let s = ''; while (i < src.length && /[A-Za-z0-9_]/.test(peek()!)) s += adv(); toks.push({ k: 'id', v: s, line: L, col: C }); continue; }
    if (c === '"') { adv(); let s = ''; while (i < src.length && peek() !== '"') { let ch = adv()!; if (ch === '\\') { const e = adv(); ch = e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '\0' : e === '\\' ? '\\' : e === '"' ? '"' : (e ?? ''); } s += ch; } if (peek() !== '"') throw new CcError(L, C, 'unterminated string literal'); adv(); toks.push({ k: 'str', v: s, line: L, col: C }); continue; }
    const two = src.substr(i, 2); if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { adv(); adv(); toks.push({ k: 'punct', v: two, line: L, col: C }); continue; }
    if ('(){};,=+-*/%<>!'.includes(c)) { adv(); toks.push({ k: 'punct', v: c, line: L, col: C }); continue; }
    throw new CcError(L, C, `unexpected character '${c}'`);
  }
  toks.push({ k: 'eof', line, col }); return toks;
}

// ---------- AST ----------
type Expr = { t: 'num'; v: number } | { t: 'var'; name: string; line: number; col: number } | { t: 'str'; v: string } | { t: 'call'; name: string; args: Expr[]; line: number; col: number } | { t: 'bin'; op: string; l: Expr; r: Expr } | { t: 'neg'; e: Expr } | { t: 'not'; e: Expr };
type Stmt = { t: 'decl'; name: string; e: Expr; line: number; col: number } | { t: 'assign'; name: string; e: Expr; line: number; col: number } | { t: 'expr'; e: Expr } | { t: 'if'; cond: Expr; then: Stmt; else?: Stmt } | { t: 'while'; cond: Expr; body: Stmt } | { t: 'block'; body: Stmt[] };

class Parser {
  p = 0;
  constructor(private toks: Tok[]) {}
  private cur() { return this.toks[this.p]!; }
  private eat(v?: string): Tok { const t = this.cur(); if (v !== undefined && !((t.k === 'punct' || t.k === 'id') && t.v === v)) throw new CcError(t.line, t.col, `expected '${v}'`); this.p++; return t; }
  private is(v: string) { const t = this.cur(); return (t.k === 'punct' || t.k === 'id') && t.v === v; }

  parseProgram(): Stmt[] {
    this.eat('int'); this.eat('main'); this.eat('(');
    if (this.is('void')) this.eat('void');
    this.eat(')'); this.eat('{');
    const body: Stmt[] = []; while (!this.is('}')) body.push(this.stmt());
    this.eat('}');
    if (this.cur().k !== 'eof') { const t = this.cur(); throw new CcError(t.line, t.col, 'only a single int main(void) is supported'); }
    return body;
  }
  private stmt(): Stmt {
    const t = this.cur();
    if (this.is('{')) return this.block();
    if (this.is('if')) { this.eat('if'); this.eat('('); const cond = this.expr(); this.eat(')'); const then = this.stmt(); let els: Stmt | undefined; if (this.is('else')) { this.eat('else'); els = this.stmt(); } return { t: 'if', cond, then, else: els }; }
    if (this.is('while')) { this.eat('while'); this.eat('('); const cond = this.expr(); this.eat(')'); const body = this.stmt(); return { t: 'while', cond, body }; }
    if (this.is('int')) { this.eat('int'); const id = this.eat() as Extract<Tok, { k: 'id' }>; if (id.k !== 'id') throw new CcError(id.line, id.col, 'expected a name'); this.eat('='); const e = this.expr(); this.eat(';'); return { t: 'decl', name: id.v, e, line: id.line, col: id.col }; }
    if (this.is('return')) throw new CcError(t.line, t.col, "'return' is not supported yet");
    if (t.k === 'id' && (this.toks[this.p + 1]!.k === 'punct') && (this.toks[this.p + 1] as Extract<Tok, { k: 'punct' }>).v === '=') { this.p++; this.eat('='); const e = this.expr(); this.eat(';'); return { t: 'assign', name: t.v, e, line: t.line, col: t.col }; }
    const e = this.expr(); this.eat(';'); return { t: 'expr', e };
  }
  private block(): Stmt { this.eat('{'); const body: Stmt[] = []; while (!this.is('}')) body.push(this.stmt()); this.eat('}'); return { t: 'block', body }; }
  private expr(): Expr { return this.or(); }
  private or(): Expr { let l = this.and(); while (this.is('||')) { this.eat('||'); l = { t: 'bin', op: '||', l, r: this.and() }; } return l; }
  private and(): Expr { let l = this.eq(); while (this.is('&&')) { this.eat('&&'); l = { t: 'bin', op: '&&', l, r: this.eq() }; } return l; }
  private eq(): Expr { let l = this.rel(); while (this.is('==') || this.is('!=')) { const op = (this.eat() as Extract<Tok, { k: 'punct' }>).v; l = { t: 'bin', op, l, r: this.rel() }; } return l; }
  private rel(): Expr { let l = this.add(); while (this.is('<') || this.is('>') || this.is('<=') || this.is('>=')) { const op = (this.eat() as Extract<Tok, { k: 'punct' }>).v; l = { t: 'bin', op, l, r: this.add() }; } return l; }
  private add(): Expr { let l = this.mul(); while (this.is('+') || this.is('-')) { const op = (this.eat() as Extract<Tok, { k: 'punct' }>).v; l = { t: 'bin', op, l, r: this.mul() }; } return l; }
  private mul(): Expr { let l = this.unary(); while (this.is('*') || this.is('/') || this.is('%')) { const op = (this.eat() as Extract<Tok, { k: 'punct' }>).v; l = { t: 'bin', op, l, r: this.unary() }; } return l; }
  private unary(): Expr { if (this.is('-')) { this.eat('-'); return { t: 'neg', e: this.unary() }; } if (this.is('!')) { this.eat('!'); return { t: 'not', e: this.unary() }; } return this.primary(); }
  private primary(): Expr {
    const t = this.cur();
    if (t.k === 'num') { this.p++; return { t: 'num', v: t.v }; }
    if (t.k === 'str') { this.p++; return { t: 'str', v: t.v }; }
    if (this.is('(')) { this.eat('('); const e = this.expr(); this.eat(')'); return e; }
    if (t.k === 'id') {
      this.p++;
      if (this.is('(')) { this.eat('('); const args: Expr[] = []; if (!this.is(')')) { args.push(this.argExpr()); while (this.is(',')) { this.eat(','); args.push(this.argExpr()); } } this.eat(')'); return { t: 'call', name: t.v, args, line: t.line, col: t.col }; }
      return { t: 'var', name: t.v, line: t.line, col: t.col };
    }
    throw new CcError(t.line, t.col, 'expected an expression');
  }
  private argExpr(): Expr { const t = this.cur(); if (t.k === 'str') { this.p++; return { t: 'str', v: t.v }; } return this.expr(); }
}

// ---------- codegen ----------
export type NscResult = { ok: true; wasm: Uint8Array } | { ok: false; diagnostics: CDiagnostic[] };
export function nsCompile(source: string): NscResult {
  try {
    const body = new Parser(lex(source)).parseProgram();
    const mod = new WasmModule();
    const importCache: Record<string, number> = {};
    const imp = (b: Builtin) => (importCache[b.import] ??= mod.addImport('env', b.import, b.params, b.results));
    // nsC variables live in wasm globals so they persist across start()/resume() suspensions.
    const stepG = mod.addGlobal();            // $step: which region to resume into
    const tmpG = mod.addGlobal();             // scratch for a blocking result with no named target
    const vars: Record<string, number> = {};
    const declare = (name: string) => (vars[name] = mod.addGlobal());
    const strs: { bytes: number[] }[] = []; const STR_BASE = 16; let strLen = 0;
    const addStr = (s: string): { ptr: number; len: number } => { const bytes = [...new TextEncoder().encode(s)]; const ptr = STR_BASE + strLen; strLen += bytes.length; strs.push({ bytes }); return { ptr, len: bytes.length }; };
    const pcG = stepG;  // the "program counter": which basic block to (re)enter

    // ---- basic-block relooper: compile the structured AST to a CFG of basic blocks, then emit a
    // `loop { br_table pc -> block }` dispatch. $pc is a global so it survives suspension, which lets
    // a blocking call anywhere (including inside loops) resume correctly. Terminators:
    type Term =
      | { k: 'goto'; t: number }
      | { k: 'ret'; status: number }
      | { k: 'cond'; t: number; f: number }      // consumes the i32 the block code left on the stack
      | { k: 'poll'; g: number; reg: number; next: number }       // recv: retry at `reg` while result == -2
      | { k: 'initiate'; g: number; next: number };               // connect: suspend to `next` once initiated
    const blocks: { code: number[]; term: Term }[] = [];
    const newBlk = (): number => { blocks.push({ code: [], term: { k: 'ret', status: 0 } }); return blocks.length - 1; };
    let cur = newBlk();                               // entry = block 0
    const emit = (bytes: number[]) => blocks[cur]!.code.push(...bytes);
    const endWith = (term: Term, nextCur: number) => { blocks[cur]!.term = term; cur = nextCur; };

    const genExpr = (e: Expr): void => {
      switch (e.t) {
        case 'num': emit(i32Const(e.v)); return;
        case 'var': { const g = vars[e.name]; if (g === undefined) throw new CcError(e.line, e.col, `use of undeclared '${e.name}'`); emit(globalGet(g)); return; }
        case 'str': throw new CcError(0, 0, 'a string is only allowed as a call argument');
        case 'neg': emit(i32Const(0)); genExpr(e.e); emit([OP.i32Sub]); return;
        case 'not': genExpr(e.e); emit([OP.i32Eqz]); return;
        case 'bin': {
          if (e.op === '&&' || e.op === '||') { genBool(e.l); genBool(e.r); emit([e.op === '&&' ? OP.i32And : OP.i32Or]); return; }
          genExpr(e.l); genExpr(e.r);
          const m: Record<string, number> = { '+': OP.i32Add, '-': OP.i32Sub, '*': OP.i32Mul, '/': OP.i32DivS, '%': OP.i32RemS, '==': OP.i32Eq, '!=': OP.i32Ne, '<': OP.i32LtS, '>': OP.i32GtS, '<=': OP.i32LeS, '>=': OP.i32GeS };
          emit([m[e.op]!]); return;
        }
        case 'call': { const b = BUILTINS[e.name]; if (b?.block) throw new CcError(e.line, e.col, `${e.name}() is a blocking call; in nsC it may only be a top-level statement in main(), not nested in an expression`); emitCall(e, true); return; }
      }
    };
    const genBool = (e: Expr): void => { genExpr(e); emit([OP.i32Eqz, OP.i32Eqz]); };  // -> 0/1

    // Emit a builtin call's arguments + call into the current block; leaves an i32 (or nothing).
    const emitCall = (e: Extract<Expr, { t: 'call' }>, needValue: boolean): void => {
      const b = BUILTINS[e.name]; if (!b) throw new CcError(e.line, e.col, `unknown function '${e.name}'`);
      if (e.args.length !== b.cParams.length) throw new CcError(e.line, e.col, `${e.name}() expects ${b.cParams.length} argument(s), got ${e.args.length}`);
      const intArg = (k: number) => { const a = e.args[k]!; if (a.t === 'str') throw new CcError(e.line, e.col, `argument ${k + 1} of ${e.name}() must be an integer`); genExpr(a); };
      if (b.special === 'recvbuf') { intArg(0); emit([...i32Const(RECV_BUF), ...i32Const(RECV_CAP)]); }
      else if (b.special === 'printbuf') { emit(i32Const(RECV_BUF)); intArg(0); }
      else if (b.special === 'sendbuf') { intArg(0); emit(i32Const(RECV_BUF)); intArg(1); }
      else {
        if (b.prefixConst !== undefined) emit(i32Const(b.prefixConst));
        e.args.forEach((arg, k) => {
          if (b.cParams[k] === 's') { if (arg.t !== 'str') throw new CcError(e.line, e.col, `argument ${k + 1} of ${e.name}() must be a string literal`); const { ptr, len } = addStr(arg.v); emit([...i32Const(ptr), ...i32Const(len)]); }
          else intArg(k);
        });
      }
      emit(call(imp(b)));
      if (b.result === 'v' && needValue) throw new CcError(e.line, e.col, `${e.name}() returns no value`);
      if (b.result === 'i' && !needValue) emit([OP.drop]);
    };

    const blockingCall = (e: Expr): Extract<Expr, { t: 'call' }> | null => (e.t === 'call' && BUILTINS[e.name]?.block ? e : null);
    const emitStmt = (s: Stmt): void => {
      // A top-level blocking call drives the CFG (suspension point); everything else is straight code.
      if (s.t === 'decl' || s.t === 'assign' || s.t === 'expr') {
        const bc = blockingCall(s.e);
        if (bc) { emitBlocking(s, bc); return; }
      }
      switch (s.t) {
        case 'decl': { if (vars[s.name] !== undefined) throw new CcError(s.line, s.col, `redeclaration of '${s.name}'`); genExpr(s.e); emit(globalSet(declare(s.name))); return; }
        case 'assign': { const g = vars[s.name]; if (g === undefined) throw new CcError(s.line, s.col, `assignment to undeclared '${s.name}'`); genExpr(s.e); emit(globalSet(g)); return; }
        case 'expr': { if (s.e.t !== 'call') throw new CcError(0, 0, 'statement has no effect'); emitCall(s.e, false); return; }
        case 'block': { for (const st of s.body) emitStmt(st); return; }
        case 'if': {
          genBool(s.cond);
          const bThen = newBlk(); const bElse = s.else ? newBlk() : -1; const bJoin = newBlk();
          endWith({ k: 'cond', t: bThen, f: s.else ? bElse : bJoin }, bThen);
          emitStmt(s.then); endWith({ k: 'goto', t: bJoin }, s.else ? bElse : bJoin);
          if (s.else) { emitStmt(s.else); endWith({ k: 'goto', t: bJoin }, bJoin); }
          return;
        }
        case 'while': {
          const bCond = newBlk(); endWith({ k: 'goto', t: bCond }, bCond);
          genBool(s.cond);
          const bBody = newBlk(); const bExit = newBlk();
          endWith({ k: 'cond', t: bBody, f: bExit }, bBody);
          emitStmt(s.body); endWith({ k: 'goto', t: bCond }, bExit);
          return;
        }
      }
    };
    const targetGlobal = (s: Stmt, call: Extract<Expr, { t: 'call' }>): number => {
      if (s.t === 'decl') { if (vars[s.name] !== undefined) throw new CcError(call.line, call.col, `redeclaration of '${s.name}'`); return declare(s.name); }
      if (s.t === 'assign') { const g = vars[s.name]; if (g === undefined) throw new CcError(call.line, call.col, `assignment to undeclared '${s.name}'`); return g; }
      return tmpG;
    };
    const emitBlocking = (s: Stmt, call: Extract<Expr, { t: 'call' }>): void => {
      const kind = BUILTINS[call.name]!.block!;
      const tgt = targetGlobal(s, call);
      if (kind === 'poll') {
        const reg = newBlk(); endWith({ k: 'goto', t: reg }, reg);     // resume re-enters `reg`
        emitCall(call, true); emit(globalSet(tgt));
        const next = newBlk(); endWith({ k: 'poll', g: tgt, reg, next }, next);
      } else {
        emitCall(call, true); emit(globalSet(tgt));
        const next = newBlk(); endWith({ k: 'initiate', g: tgt, next }, next);
      }
    };

    for (const s of body) emitStmt(s);
    // trailing block falls off the end of main -> exit
    blocks[cur]!.term = { k: 'ret', status: 0 };

    // ---- assemble the dispatch: loop { block*n { br_table pc } <block k code + terminator> } ----
    const n = blocks.length;
    const setPc = (t: number) => [...i32Const(t), ...globalSet(pcG)];
    const assembleTerm = (term: Term, depth: number): number[] => {
      switch (term.k) {
        case 'goto': return [...setPc(term.t), OP.br, ...uleb(depth)];
        case 'ret': return [...i32Const(term.status), OP.ret];
        case 'cond': return [OP.if_, VOID_BLOCK, ...setPc(term.t), OP.br, ...uleb(depth + 1), OP.else_, ...setPc(term.f), OP.br, ...uleb(depth + 1), OP.end];
        case 'poll': return [...globalGet(term.g), ...i32Const(-2), OP.i32Eq, OP.if_, VOID_BLOCK, ...setPc(term.reg), ...i32Const(1), OP.ret, OP.end, ...setPc(term.next), OP.br, ...uleb(depth)];
        case 'initiate': return [...globalGet(term.g), ...i32Const(0), OP.i32Eq, OP.if_, VOID_BLOCK, ...setPc(term.next), ...i32Const(1), OP.ret, OP.end, ...setPc(term.next), OP.br, ...uleb(depth)];
      }
    };
    const code: number[] = [OP.loop, VOID_BLOCK];
    for (let i = 0; i < n; i++) code.push(OP.block, VOID_BLOCK);
    code.push(...globalGet(pcG), OP.brTable, ...uleb(n), ...Array.from({ length: n }, (_, j) => uleb(j)).flat(), ...uleb(0));
    for (let k = 0; k < n; k++) { code.push(OP.end); code.push(...blocks[k]!.code); code.push(...assembleTerm(blocks[k]!.term, n - 1 - k)); }
    code.push(OP.end, OP.unreachable);   // end loop; the loop never falls through

    const runIdx = mod.addFunc([], [i32], 0, code);        // the state machine
    mod.addFunc([], [i32], 0, [...call(runIdx)], 'start');
    mod.addFunc([], [i32], 0, [...call(runIdx)], 'resume');
    for (let k = 0, off = STR_BASE; k < strs.length; k++) { mod.addData(off, strs[k]!.bytes); off += strs[k]!.bytes.length; }
    return { ok: true, wasm: mod.emit() };
  } catch (e) {
    if (e instanceof CcError) return { ok: false, diagnostics: [{ line: e.line || 1, col: e.col || 1, message: e.message, severity: 'error' }] };
    return { ok: false, diagnostics: [{ line: 1, col: 1, message: `compiler error: ${(e as Error).message}`, severity: 'error' }] };
  }
}
