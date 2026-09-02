// Session file format: JSON with Uint8Arrays as {__u8: base64}. Downloadable and resumable.
import { toBase64, fromBase64 } from '@/shared/bytes';
import type { EngineState } from '@/engine/types';

export interface SessionFile { format: 'netsim-session'; version: 1; savedAt: string; ui: { theme?: string }; state: EngineState }

export function serializeSession(state: EngineState, ui: { theme?: string } = {}): string {
  const file: SessionFile = { format: 'netsim-session', version: 1, savedAt: new Date().toISOString(), ui, state };
  return JSON.stringify(file, (_k, v) => (v instanceof Uint8Array ? { __u8: toBase64(v) } : v));
}
export function parseSession(json: string): SessionFile {
  const file = JSON.parse(json, (_k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' ? fromBase64(v.__u8) : v));
  if (!file || file.format !== 'netsim-session') throw new Error('Not a NetSim session file');
  if (file.version !== 1) throw new Error(`Unsupported session version ${file.version}`);
  if (!file.state || file.state.version !== 1) throw new Error('Corrupt session state');
  return file as SessionFile;
}
