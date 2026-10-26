/** Expected planning states for fixture-only replay; acceptance is tested against Carbon. */
import {cast,fullFiles,handoff,receipt,report,accepted} from './fixtures.mjs';
import {dump,encodeReturn} from '../src/kit.mjs';
import {encode,decode,entry,patchScalarFrontmatter} from '../src/validation.mjs';
export function planningFixture(playbooks=[]) {
  const original=fullFiles(),plan='---\nid: ent-plan\nkind: plan\nstatus: proposed # retain this comment\n---\n# Plan\n'+accepted+'\nAccepted decision: use supplied source only.\nSource: entries/source.md.\nPending: field assessment, then license investigation.\n';
  original.set('entries/plan.md',encode(plan));
  const c1={...cast('report'),assignment_id:'cast-planning-research',dispatch_id:'dispatch-planning-research',read:[...cast('report').read,'entries/plan.md'],replace:['entries/plan.md'],metadata:[{path:'entries/plan.md',keys:['status']}],required_files:['entries/report.md','entries/plan.md'],playbooks};
  const plan5=plan.replace(entry(plan).frontmatter,patchScalarFrontmatter(entry(plan).frontmatter,'status','active'))+'\nReport proposal for review: entries/report.md. Receipt: checkpoint-planning-1.\nPending: verify license evidence.\n';
  const r1=encodeReturn(receipt(c1,{checkpoint_id:'checkpoint-planning-1',creates:['entries/report.md'],replaces:['entries/plan.md']}),new Map([['entries/report.md',report],['entries/plan.md',plan5]]));
  const expected5=new Map(original);expected5.set('stack.yaml',encode(decode(original.get('stack.yaml')).replace('revision: 4','revision: 5')));expected5.set('entries/plan.md',encode(plan5));expected5.set('entries/report.md',encode(report));
  const c2={...c1,assignment_id:'cast-planning-license',dispatch_id:'dispatch-planning-license',base_revision:5,objective:'Investigate license evidence in the accepted report and source.',read:[...c1.read,'entries/report.md'],create:['entries/investigation.md'],required_files:['entries/investigation.md','entries/plan.md']};
  const note='---\nid: ent-license-investigation\nkind: investigation\n---\n# License evidence\nThe supplied source does not establish a license.\nEvidence: entries/source.md and accepted entries/report.md.\nPending: obtain publisher terms through an approved source.\n';
  const plan6=plan5.replace(entry(plan5).frontmatter,patchScalarFrontmatter(entry(plan5).frontmatter,'status','blocked'))+'\nPending: obtain publisher terms; do not infer acquisition permission. Receipt: checkpoint-planning-2.\n';
  const r2=encodeReturn(receipt(c2,{checkpoint_id:'checkpoint-planning-2',status:'blocked',summary:'Source terms missing; proposed investigation note and plan checkpoint are complete.',blockers:['Publisher terms not supplied.'],next:['Obtain publisher terms via an approved source.'],creates:['entries/investigation.md'],replaces:['entries/plan.md']}),new Map([['entries/investigation.md',note],['entries/plan.md',plan6]]));
  const expected6=new Map(expected5);expected6.set('stack.yaml',encode(decode(expected5.get('stack.yaml')).replace('revision: 5','revision: 6')));expected6.set('entries/plan.md',encode(plan6));expected6.set('entries/investigation.md',encode(note));
  const c3={...c2,assignment_id:'cast-planning-resume',dispatch_id:'dispatch-planning-resume',base_revision:6,objective:'Resume the license inquiry from accepted files; report missing inputs.',read:[...c2.read,'entries/investigation.md'],create:[],required_files:[]};
  return {original,expected5,expected6,first:{cast:c1,castSource:dump(c1),context:handoff(c1,original),source:r1},second:{cast:c2,castSource:dump(c2),context:handoff(c2,expected5),source:r2},resume:{cast:c3,castSource:dump(c3),context:handoff(c3,expected6)}};
}
