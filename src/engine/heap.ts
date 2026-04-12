// Binary min-heap over sim events ordered by (t, seq). Stored as a plain array in state.
export interface HeapItem { t: number; seq: number }
function less(a: HeapItem, b: HeapItem) { return a.t < b.t || (a.t === b.t && a.seq < b.seq); }
export function heapPush<T extends HeapItem>(h: T[], item: T) {
  h.push(item); let i = h.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (less(h[i]!, h[p]!)) { [h[i], h[p]] = [h[p]!, h[i]!]; i = p; } else break; }
}
export function heapPop<T extends HeapItem>(h: T[]): T | undefined {
  if (h.length === 0) return undefined; const top = h[0]!; const last = h.pop()!;
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && less(h[l]!, h[m]!)) m = l; if (r < h.length && less(h[r]!, h[m]!)) m = r; if (m === i) break; [h[i], h[m]] = [h[m]!, h[i]!]; i = m; } }
  return top;
}
export function heapPeek<T extends HeapItem>(h: T[]): T | undefined { return h[0]; }
/** Remove all items matching predicate (O(n) rebuild). */
export function heapRemoveWhere<T extends HeapItem>(h: T[], pred: (x: T) => boolean) {
  const keep = h.filter(x => !pred(x)); h.length = 0; for (const k of keep) heapPush(h, k);
}
