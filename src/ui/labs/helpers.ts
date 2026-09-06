// Builder helpers shared by all labs: construct a topology with the engine builders and pack it
// into a session with the guided scenario (id + title + description + checks).
import * as E from '@/engine/engine';
import { serializeSession } from '@/session/session';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import type { EngineState, ScenarioCheck } from '@/engine/types';
import type { Lab } from './types';
export const ip = ipToU32; export const mask = prefixToMask;
export const m = (n: number) => prefixToMask(n);
export function pack(st: EngineState, lab: { id: string; name: string; intro: string; checks: ScenarioCheck[] }): string {
  st.scenario = { id: lab.id, title: lab.name, description: lab.intro, checks: lab.checks };
  return serializeSession(st, {});
}
/** Convenience: assemble a lab's build() output from a topology-building function. */
export function scene(id: string, name: string, intro: string, checks: ScenarioCheck[], make: (st: EngineState) => void): string {
  const st = E.createState(1); make(st); return pack(st, { id, name, intro, checks });
}
export { E };
export type { Lab };
