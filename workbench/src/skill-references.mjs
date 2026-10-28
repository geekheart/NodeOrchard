const ACTIVE_RUN = new Set(['preparing', 'queued', 'running', 'waiting', 'waiting_review']);
const ACTIVE_LEARNING = new Set(['preparing', 'running', 'waiting']);

// Read current definitions and live execution snapshots, never infer ownership
// from a completed run or rewrite historical evidence when a Skill is removed.
export function skillReferences(app, name) {
  const db = app.store.db, result = [], seen = new Set();
  const add = (kind, id, nodeId) => {
    const key = JSON.stringify([kind, id, nodeId]); if (seen.has(key)) return; seen.add(key);
    if (result.length < 20) result.push({ kind, id: String(id).slice(0, 128), ...(nodeId ? { nodeId: String(nodeId).slice(0, 128) } : {}) });
  };
  const has = table => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const document = (value, kind, id) => {
    if (!value || typeof value !== 'object') { add('unconfirmed', kind); return; }
    const visited = new WeakSet(); let count = 0;
    const walk = (doc, depth = 0) => {
      if (!doc || typeof doc !== 'object' || visited.has(doc)) return;
      visited.add(doc);
      if (depth > 12 || !Array.isArray(doc.nodes) || (count += doc.nodes.length) > 20000) { add('unconfirmed', kind); return; }
      for (const node of doc.nodes) {
        if (node?.type === 'skill' && node.config?.skillRef === name) add(kind, id, node.id);
        if (['subflow', 'foreach', 'loop'].includes(node?.type) && node.config?.document) walk(node.config.document, depth + 1);
      }
    };
    walk(value);
  };
  const rows = (table, select, consume) => {
    if (!has(table)) return;
    try {
      const values = db.prepare(select).all();
      if (values.length > 10000) { add('unconfirmed', table); return; }
      for (const row of values) { try { consume(row); } catch { add('unconfirmed', table); } }
    } catch { add('unconfirmed', table); }
  };
  rows('workflow_documents', 'SELECT id,document FROM workflow_documents', row => {
    if (has('workflow_library_meta') && db.prepare('SELECT 1 FROM workflow_library_meta WHERE key=?').get('deleted:' + row.id)) return;
    document(JSON.parse(row.document), 'workflow', row.id);
  });
  rows('workflow_schedules', 'SELECT id,value FROM workflow_schedules', row => {
    const value = JSON.parse(row.value); if (value.enabled === true) document(value.document, 'schedule', row.id);
  });
  const run = (value, id) => {
    if (!ACTIVE_RUN.has(value.status)) return;
    document(value.document, 'run', id);
    if (value.skills?.some(skill => skill.name === name || skill.baseName === name)) add('run', id);
  };
  rows('workflow_runs', 'SELECT id,value FROM workflow_runs', row => run(JSON.parse(row.value), row.id));
  for (const manager of [app.workflows, app.workflows?.dag]) for (const [id, state] of manager?.active || []) run(state.run || state, id);
  const learning = (value, id) => {
    if (!ACTIVE_LEARNING.has(value.status)) return;
    document(value.document, 'learning', id);
    for (const doc of [value.bestDocument, ...(value.rounds || []).map(round => round.document)]) if (doc) document(doc, 'learning', id);
  };
  rows('workflow_learning', 'SELECT id,value FROM workflow_learning', row => learning(JSON.parse(row.value), row.id));
  for (const [id, state] of app.learning?.active || []) learning(state.job || state, id);
  rows('learned_skills', 'SELECT id,value FROM learned_skills', row => {
    const value = JSON.parse(row.value);
    if (row.id !== name && !value.deletedAt && (value.baseName === name || value.parentRef === name)) add('derived-skill', row.id);
  });
  return result;
}
