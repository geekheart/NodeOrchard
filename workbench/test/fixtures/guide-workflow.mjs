// Synthetic legacy-plan fixture. It has no local paths, real Skill versions or board identity.
import { createDocument, createNode, connectNodes, validateDocument } from '../../shared/workflow/workflow-model.mjs';

export function createGuideWorkflow() {
  const revision = 'sha256:' + 'a'.repeat(64);
  const node = (id, type, config = {}) => createNode(type, { x: 0, y: 0 }, { id, config });
  const operation = id => node(id, 'tool', { executionMode: 'code', language: 'javascript',
    inputType: 'object', outputType: 'object', code: 'return input;', timeoutSeconds: 30 });
  const skill = id => node(id, 'skill', { inputType: 'object', outputType: 'object',
    skillRef: 'fixture-' + id, version: revision });
  let document = createDocument({ title: 'Synthetic guide plan' });
  document.nodes = [node('input', 'input', { outputType: 'object' }), operation('prepare'),
    skill('annotation-skill'), operation('annotate'), skill('author-skill'), operation('write'),
    operation('verify'), node('output', 'output'), node('evaluation', 'evaluation',
      { comparison: 'model', valuePath: 'learningComparison' }), node('improvement', 'improvement',
      { scope: 'skills', targetSkillNodeIds: ['author-skill', 'annotation-skill'] })];
  for (let index = 1; index < 8; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  for (const [sourceNode, targetNode] of [['verify', 'evaluation'], ['evaluation', 'improvement']]) {
    document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  }
  return validateDocument(document);
}
