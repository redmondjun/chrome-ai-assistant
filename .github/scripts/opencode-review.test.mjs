import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeOpenCodeFailure,
  extractReviewResponse,
  formatReviewableRanges,
  isTrustedReviewTrigger,
  MAX_REVIEW_ATTEMPTS,
  OPENCODE_ATTEMPT_TIMEOUT_MS,
  parseReviewableLines,
  reviewReadiness,
  validateReviewResponse,
} from './opencode-review.mjs';

test('classifies and sanitizes OpenCode provider failures', () => {
  const failure = describeOpenCodeFailure(
    {
      status: 1,
      signal: null,
      error: undefined,
      stderr:
        'HTTP 429 rate limit: Authorization=Bearer top-secret token=abc123 api_key=nvapi-secret',
    },
    42
  );
  assert.equal(failure.category, 'rate-limit');
  assert.equal(failure.elapsedSeconds, 42);
  assert.doesNotMatch(JSON.stringify(failure), /top-secret|abc123|nvapi-secret/);
});

test('distinguishes timeout and network failures', () => {
  assert.equal(
    describeOpenCodeFailure(
      { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: 'timed out' } },
      360
    ).category,
    'timeout'
  );
  assert.equal(
    describeOpenCodeFailure({ status: 1, stderr: 'TypeError: fetch failed' }, 10).category,
    'network'
  );
});

test('keeps all OpenCode review attempts inside the workflow timeout', () => {
  const workflowTimeoutMs = 20 * 60 * 1000;
  const setupAndPostingReserveMs = 5 * 60 * 1000;
  assert.ok(
    OPENCODE_ATTEMPT_TIMEOUT_MS * MAX_REVIEW_ATTEMPTS <=
      workflowTimeoutMs - setupAndPostingReserveMs
  );
});

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

test('formats exact reviewable line ranges for model grounding', () => {
  const reviewable = new Map([
    ['src/new.ts', new Set([1, 2, 3, 7, 9, 10])],
    ['src/other.ts', new Set([42])],
  ]);
  assert.equal(formatReviewableRanges(reviewable), 'src/new.ts:1-3,7,9-10\nsrc/other.ts:42');
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
