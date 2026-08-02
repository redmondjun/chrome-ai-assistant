import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
const MAX_FINDINGS = 10;

export function parseReviewableLines(diff) {
  const reviewable = new Map();
  let path = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      path = line.slice(6);
      if (!reviewable.has(path)) reviewable.set(path, new Set());
      inHunk = false;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(line.match(/^@@ -(\d+)/)?.[1] ?? 0);
      newLine = Number(hunk[1]);
      inHunk = Boolean(path);
      continue;
    }
    if (!inHunk || !path || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+')) {
      reviewable.get(path).add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      oldLine += 1;
    } else {
      reviewable.get(path).add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return reviewable;
}

export function validateReviewResponse(value, reviewable) {
  if (!value || typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('Review response must contain a summary');
  }
  if (!Array.isArray(value.findings)) throw new Error('Review response must contain findings');
  if (value.findings.length > MAX_FINDINGS) throw new Error(`Review exceeds ${MAX_FINDINGS} findings`);
  const seen = new Set();
  for (const finding of value.findings) {
    if (!reviewable.get(finding.path)?.has(Number(finding.line))) {
      throw new Error(`Finding is outside the PR diff: ${finding.path}:${finding.line}`);
    }
    if (!['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      throw new Error(`Invalid severity at ${finding.path}:${finding.line}`);
    }
    if (typeof finding.title !== 'string' || !finding.title.trim()) {
      throw new Error(`Missing finding title at ${finding.path}:${finding.line}`);
    }
    if (typeof finding.body !== 'string' || !finding.body.trim()) {
      throw new Error(`Missing finding body at ${finding.path}:${finding.line}`);
    }
    const key = `${finding.path}:${Number(finding.line)}:${finding.title.trim().toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate finding: ${key}`);
    seen.add(key);
    finding.line = Number(finding.line);
  }
  return value;
}

function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) objects.push(text.slice(start, index + 1));
    }
  }
  return objects;
}

export function extractReviewResponse(stdout, reviewable) {
  const text = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const event = JSON.parse(line);
        return event.type === 'text' && typeof event.part?.text === 'string'
          ? [event.part.text]
          : [];
      } catch {
        return [];
      }
    })
    .join('')
    .trim();
  let validationError = null;
  for (const candidate of extractJsonObjects(text).reverse()) {
    try {
      return validateReviewResponse(JSON.parse(candidate), reviewable);
    } catch (error) {
      validationError = error;
      // Continue until a schema-valid review is found.
    }
  }
  if (validationError) throw validationError;
  throw new Error('OpenCode did not return a valid structured review');
}

async function githubApi(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

async function getAppToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('GitHub OIDC environment is unavailable');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const oidc = await fetch(`${requestUrl}${separator}audience=opencode-github-action`, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (!oidc.ok) throw new Error(`Unable to obtain GitHub OIDC token: ${oidc.status}`);
  const { value } = await oidc.json();
  const exchange = await fetch('https://api.opencode.ai/exchange_github_app_token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${value}` },
  });
  if (!exchange.ok) throw new Error(`Unable to obtain OpenCode App token: ${exchange.status}`);
  return (await exchange.json()).token;
}

function runOpenCode(prompt, reviewable) {
  const childEnv = { ...process.env };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  delete childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete childEnv.ACTIONS_ID_TOKEN_REQUEST_URL;
  const promptFile = '.opencode-review-prompt.md';
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  try {
    const paths = [...reviewable.keys()];
    const result = spawnSync(
      'opencode',
      [
        'run',
        `Review the attached PR context. Return ONLY one JSON object, with no prose or Markdown. Required shape: {"summary":"concise review","findings":[{"path":"one valid path","line":123,"severity":"critical|high|medium|low","title":"short title","body":"specific impact and fix guidance"}]}. Use an empty findings array when there are no actionable issues. Valid paths: ${paths.join(', ')}`,
        '--auto',
        '--format',
        'json',
        '--agent',
        'pr-inline-reviewer',
        '--model',
        MODEL,
        '--file',
        promptFile,
      ],
      {
        encoding: 'utf8',
        env: childEnv,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
      }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'OpenCode failed');
    return result.stdout;
  } finally {
    unlinkSync(promptFile);
  }
}

function formatFinding(finding) {
  return `**[${finding.severity.toUpperCase()}] ${finding.title.trim()}**\n\n${finding.body.trim()}\n\nReply with \`/oc address\` to evaluate and address this finding.`;
}

async function main() {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!TRUSTED_ASSOCIATIONS.has(payload.comment?.author_association)) {
    throw new Error('The triggering author is not trusted');
  }
  const repository = payload.repository.full_name;
  const [owner, repo] = repository.split('/');
  const prNumber = payload.issue?.number ?? payload.pull_request?.number;
  if (!prNumber || (payload.issue && !payload.issue.pull_request)) {
    throw new Error('Review commands are supported only on pull requests');
  }

  let token = await getAppToken();
  const pr = await githubApi(token, `/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (pr.state !== 'open') throw new Error('The pull request is not open');
  if (pr.head.repo.full_name !== repository) throw new Error('Fork pull requests are not supported');
  const diffResponse = await fetch(pr.diff_url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3.diff' },
  });
  if (!diffResponse.ok) throw new Error(`Unable to fetch PR diff: ${diffResponse.status}`);
  const diff = await diffResponse.text();
  const reviewable = parseReviewableLines(diff);
  if (!reviewable.size) throw new Error('The pull request has no reviewable text lines');

  const agentDefinition = readFileSync('.opencode/agents/pr-inline-reviewer.md', 'utf8');
  execFileSync('git', ['fetch', 'origin', pr.head.sha], { stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', pr.head.sha], { stdio: 'inherit' });
  mkdirSync('.opencode/agents', { recursive: true });
  writeFileSync('.opencode/agents/pr-inline-reviewer.md', agentDefinition, { mode: 0o600 });
  const prompt = `Review PR #${prNumber}: ${pr.title}\n\nTriggering request: ${payload.comment.body}\n\nPR description:\n${pr.body ?? ''}\n\nReport only actionable issues introduced by this PR. Every finding must use a path and RIGHT-side line present in the diff below. Prefer the smallest useful set and return at most ${MAX_FINDINGS}.\n\nReturn exactly:\n{"summary":"concise overall review","findings":[{"path":"src/file.ts","line":12,"severity":"critical|high|medium|low","title":"short title","body":"specific impact and fix guidance"}]}\n\nPR diff:\n${diff}`;
  const response = extractReviewResponse(runOpenCode(prompt, reviewable), reviewable);

  token = await getAppToken();
  const existing = await githubApi(
    token,
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`
  );
  const findings = response.findings.filter(
    finding =>
      !existing.some(
        comment =>
          comment.path === finding.path &&
          Number(comment.line ?? comment.original_line) === finding.line &&
          comment.body.includes(finding.title.trim())
      )
  );
  const body = `## OpenCode review\n\n${response.summary.trim()}\n\n${findings.length ? `${findings.length} inline finding${findings.length === 1 ? '' : 's'} posted.` : 'No new inline findings.'}`;
  await githubApi(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      commit_id: pr.head.sha,
      event: 'COMMENT',
      body,
      comments: findings.map(finding => ({
        path: finding.path,
        line: finding.line,
        side: 'RIGHT',
        body: formatFinding(finding),
      })),
    }),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
