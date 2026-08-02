import assert from 'node:assert/strict';
import test from 'node:test';

import {
  childBranchName,
  extractAgentResponse,
  isOpenCodeChildPr,
  isTrustedAssociation,
  parseCommand,
  parseCommentUrl,
  validateChangeResult,
  validateAgentResponse,
  validatePullRequest,
} from './opencode-address.mjs';

test('accepts only trusted repository associations', () => {
  assert.equal(isTrustedAssociation('OWNER'), true);
  assert.equal(isTrustedAssociation('MEMBER'), true);
  assert.equal(isTrustedAssociation('COLLABORATOR'), true);
  assert.equal(isTrustedAssociation('CONTRIBUTOR'), false);
  assert.equal(isTrustedAssociation('NONE'), false);
});

test('parses address scope and model flags', () => {
  assert.deepEqual(parseCommand('/oc address all --ultra'), {
    all: true,
    comment: null,
    instruction: 'all',
    model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
  });
  assert.equal(
    parseCommand('/opencode address --super').model,
    'nvidia/nvidia/nemotron-3-super-120b-a12b'
  );
  assert.equal(parseCommand('/oc address').model, 'nvidia/deepseek-ai/deepseek-v4-pro');
  assert.equal(parseCommand('please /oc address'), null);
  assert.equal(parseCommand('/oc review this'), null);
});

test('parses top-level and inline GitHub comment URLs', () => {
  assert.deepEqual(parseCommentUrl('https://github.com/o/r/pull/1#issuecomment-42'), {
    type: 'issue',
    id: 42,
  });
  assert.deepEqual(parseCommentUrl('https://github.com/o/r/pull/1#discussion_r99'), {
    type: 'review',
    id: 99,
  });
  assert.equal(parseCommentUrl('https://example.com'), null);
});

test('uses one stable child branch and suffixes a completed generation', () => {
  assert.equal(childBranchName(7), 'opencode/pr-7-fixes');
  assert.equal(
    childBranchName(7, true, new Date('2026-08-02T12:34:56Z')),
    'opencode/pr-7-fixes-20260802123456'
  );
});

test('recognizes an OpenCode child PR without creating grandchildren', () => {
  assert.equal(
    isOpenCodeChildPr({
      head: { ref: 'opencode/pr-7-fixes' },
      body: '<!-- opencode-address-parent: 7 -->',
    }),
    true
  );
  assert.equal(isOpenCodeChildPr({ head: { ref: 'feature' }, body: '' }), false);
});

test('rejects closed and fork pull requests', () => {
  const local = { state: 'open', head: { repo: { full_name: 'owner/repo' } } };
  assert.equal(validatePullRequest(local, 'owner/repo'), local);
  assert.throws(() => validatePullRequest({ ...local, state: 'closed' }, 'owner/repo'), /not open/);
  assert.throws(
    () =>
      validatePullRequest({ ...local, head: { repo: { full_name: 'fork/repo' } } }, 'owner/repo'),
    /Fork pull requests/
  );
});

test('requires applied decisions and working-tree changes to agree', () => {
  const apply = [{ decision: 'apply' }];
  const disagree = [{ decision: 'disagree' }];
  assert.deepEqual(validateChangeResult(true, apply), apply);
  assert.deepEqual(validateChangeResult(false, disagree), []);
  assert.throws(() => validateChangeResult(false, apply), /produced no changes/);
  assert.throws(() => validateChangeResult(true, disagree), /without choosing apply/);
});

test('validates one structured outcome per target', () => {
  const value = {
    results: [
      { comment_id: 10, decision: 'apply', reply: 'Applied.' },
      { comment_id: 11, decision: 'disagree', reply: 'This would regress behavior.' },
      { comment_id: 12, decision: 'clarify', reply: 'Which behavior is intended?' },
    ],
  };
  assert.equal(validateAgentResponse(value, [10, 11, 12]), value);
  assert.throws(() => validateAgentResponse(value, [10, 11]), /Unexpected comment result/);
  assert.throws(
    () =>
      validateAgentResponse(
        { results: [{ comment_id: 10, decision: 'maybe', reply: 'No.' }] },
        [10]
      ),
    /Invalid decision/
  );
});

test('extracts the final JSON response from OpenCode JSON events', () => {
  const stdout = [
    JSON.stringify({ type: 'step_start', part: {} }),
    JSON.stringify({
      type: 'text',
      part: {
        text: '{"results":[{"comment_id":5,"decision":"disagree","reply":"Not applicable."}]}',
      },
    }),
  ].join('\n');
  assert.equal(extractAgentResponse(stdout, [5]).results[0].decision, 'disagree');
});

test('extracts a validated JSON object when the model wraps it in prose', () => {
  const response = {
    results: [{ comment_id: 5, decision: 'clarify', reply: 'A decision is needed.' }],
  };
  const stdout = JSON.stringify({
    type: 'text',
    part: { text: `I've addressed the feedback.\n\`\`\`json\n${JSON.stringify(response)}\n\`\`\`` },
  });
  assert.equal(extractAgentResponse(stdout, [5]).results[0].decision, 'clarify');
});
