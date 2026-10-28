import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { skillReferences } from '../src/skill-references.mjs';

const doc = name => ({ nodes: [{ id: 'inside', type: 'skill', config: { skillRef: name } }] });
test('Skill references include nested saved and trashed definitions, enabled schedules, live runs, learning and descendants', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE workflow_documents(id TEXT,document TEXT); CREATE TABLE workflow_library_meta(key TEXT,value TEXT);');
  for (const table of ['workflow_schedules', 'workflow_runs', 'workflow_learning', 'learned_skills']) db.exec(`CREATE TABLE ${table}(id TEXT,value TEXT)`);
  const insert = (table, id, value) => db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(id, JSON.stringify(value));
  insert('workflow_documents', 'trash-preserved', { nodes: [{ type: 'foreach', config: { document: doc('target') } }] });
  insert('workflow_documents', 'permanently-deleted', doc('target')); db.prepare('INSERT INTO workflow_library_meta VALUES(?,?)').run('deleted:permanently-deleted', 'true');
  insert('workflow_schedules', 'enabled-schedule', { enabled: true, document: doc('target') });
  insert('workflow_schedules', 'disabled-schedule', { enabled: false, document: doc('target') });
  insert('workflow_runs', 'live-run', { status: 'waiting_review', document: doc('target') });
  insert('workflow_runs', 'completed-history', { status: 'complete', document: doc('target') });
  insert('workflow_learning', 'learning-job', { status: 'waiting', document: doc('other'), bestDocument: doc('target') });
  insert('learned_skills', 'published-descendant', { baseName: 'target' });
  insert('learned_skills', 'deleted-descendant', { baseName: 'target', deletedAt: '2026-01-01' });
  const references = skillReferences({ store: { db } }, 'target');
  assert.deepEqual(new Set(references.map(row => row.kind)), new Set(['workflow', 'schedule', 'run', 'learning', 'derived-skill']));
  assert.equal(references.some(row => ['permanently-deleted', 'disabled-schedule', 'completed-history', 'deleted-descendant'].includes(row.id)), false);
});

test('malformed reference records fail closed and managers can protect not-yet-persisted active snapshots', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('CREATE TABLE workflow_runs(id TEXT,value TEXT)');
  db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('broken', 'invalid json');
  const references = skillReferences({ store: { db }, workflows: { active: new Map([['starting', { run: { status: 'preparing', document: doc('target') } }]]) } }, 'target');
  assert.ok(references.some(row => row.kind === 'unconfirmed')); assert.ok(references.some(row => row.kind === 'run' && row.id === 'starting'));
});
