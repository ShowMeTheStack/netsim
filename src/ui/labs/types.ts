// Rich guided-lab content. The topology + live checks go into the engine (via build()); the
// guided content (theory, steps, questions) lives here in the UI and is shown in the Lab drawer.
import type { ScenarioCheck } from '@/engine/types';

export interface LabStep {
  title: string;            // short imperative, e.g. "Enable OSPF on R1"
  do: string;               // detailed instruction
  set?: string[];           // concrete values to enter, rendered as chips
  observe?: string;         // what to watch for
  note?: string;            // note-taking prompt (answer recorded in the lab notes)
  checkId?: string;         // a check that auto-completes this step when it passes
}
export interface LabQuestion { q: string; a: string }
export interface Lab {
  id: string; module: string; name: string;
  difficulty: 'intro' | 'core' | 'advanced'; minutes: number;
  objectives: string[];
  theory: string[];         // paragraphs of background (plain text; **bold** and `code` supported)
  build: () => string;      // returns a session JSON (topology + engine scenario with matching checks)
  checks: ScenarioCheck[];  // the same checks embedded by build(), listed here for the drawer
  steps: LabStep[];
  questions?: LabQuestion[];
  wrap?: string;            // closing summary / what they learned
}
export interface LabModule { id: string; name: string; blurb: string }
