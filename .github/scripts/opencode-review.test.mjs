import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractReviewResponse,
  isTrustedReviewTrigger,
  parseReviewableLines,
  reviewReadiness,
  validateReviewResponse,
} from './opencode-review.mjs';

test('accepts automatic pull request events and trusted manual commands', () => {
  assert.equal(isTrustedReviewTrigger('pull_request', { pull_request: {} }), true);
  assert.equal(
    isTrustedReviewTrigger('issue_comment', { comment: { author_association: 'OWNER' } }),
    true
  );
  assert.equal(
    isTrustedReviewTrigger('issue_comment', { comment: { author_association: 'CONTRIBUTOR' } }),
    false
  );
});

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,3 +2,4 @@
 context
-old
+new
+added
 tail`;

test('extracts right-side reviewable lines from unified diffs', () => {
  const lines = parseReviewableLines(diff);
  assert.deepEqual([...lines.get('src/a.ts')], [2, 3, 4, 5]);
});

test('does not treat the next file header as reviewable code', () => {
  const lines = parseReviewableLines(`${diff}\ndiff --git a/src/b.ts b/src/b.ts\nnew file mode 100644`);
  assert.deepEqual([...lines.get('src/a.ts')], [2, 3, 4, 5]);
});

test('rejects findings outside the PR diff', () => {
  const lines = parseReviewableLines(diff);
  const valid = {
    summary: 'One issue found.',
    findings: [
      {
        path: 'src/a.ts',
        line: 4,
        severity: 'high',
        title: 'Unchecked value',
        body: 'Validate this value before using it.',
      },
    ],
  };
  assert.equal(validateReviewResponse(valid, lines), valid);
  assert.throws(
    () => validateReviewResponse({ ...valid, findings: [{ ...valid.findings[0], line: 99 }] }, lines),
    /outside the PR diff/
  );
});

test('extracts a structured review from OpenCode JSON events', () => {
  const lines = parseReviewableLines(diff);
  const review = {
    summary: 'No blocking issues.',
    findings: [],
  };
  const stdout = JSON.stringify({
    type: 'text',
    part: { text: `Review complete.\n${JSON.stringify(review)}` },
  });
  assert.deepEqual(extractReviewResponse(stdout, lines), review);
});

test('defers reviews until GitHub reports the PR as mergeable', () => {
  assert.equal(reviewReadiness({ mergeable: false, mergeable_state: 'dirty' }), 'conflicted');
  assert.equal(reviewReadiness({ mergeable: null, mergeable_state: 'unknown' }), 'unknown');
  assert.equal(reviewReadiness({ mergeable: true, mergeable_state: 'clean' }), 'ready');
  assert.equal(reviewReadiness({ mergeable: true, mergeable_state: 'blocked' }), 'ready');
});
