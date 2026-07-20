export interface LinkSafetyInput {
  url: string;
  text?: string;
  title?: string;
  context?: string;
}

export interface LinkSafetyResult {
  safe: boolean;
  reason?: string;
}

const ACTION_WORDS =
  'create|edit|delete|remove|merge|transition|approve|submit|save|deploy|trigger|close|reopen';
const ACTION_LABEL = new RegExp(
  `^(?:${ACTION_WORDS})(?:\\s+(?:a|the|new))?(?:\\s+(?:branch|pr|pull request|merge request|issue|ticket|page|release|build|deployment))?(?:\\s*[.…]*)?$`,
  'i'
);
const ACTION_PHRASE = new RegExp(
  `\\b(?:${ACTION_WORDS})\\s+(?:a\\s+|the\\s+|new\\s+)?(?:branch|pr|pull request|merge request|issue|ticket|page|release|build|deployment)\\b`,
  'i'
);
const ACTION_URL = new RegExp(
  `(?:${ACTION_WORDS})[-_/]?(?:branch|pr|pull-?request|merge-?request|issue|ticket|page|release|build|deployment)|(?:^|[/=?&])(?:${ACTION_WORDS})(?:[/?#&.=]|$)|workflowuidispatcher|createbranch|branchcreate|createpullrequest`,
  'i'
);

export function evaluateLinkSafety(link: LinkSafetyInput): LinkSafetyResult {
  let decodedUrl = link.url;
  try {
    decodedUrl = decodeURIComponent(link.url);
  } catch {
    // Use the original URL when malformed escapes cannot be decoded.
  }

  if (ACTION_URL.test(decodedUrl)) {
    return { safe: false, reason: 'URL appears to perform an authenticated action.' };
  }

  const label = `${link.text || ''} ${link.title || ''}`.trim();
  if (ACTION_LABEL.test(label) || ACTION_PHRASE.test(label)) {
    return { safe: false, reason: 'Link label describes a state-changing action.' };
  }
  const genericLabel = !label || /^(?:here|open|go|link|action|more|click here|view)$/i.test(label);
  if (genericLabel && ACTION_PHRASE.test(link.context || '')) {
    return { safe: false, reason: 'Surrounding link context describes a state-changing action.' };
  }
  return { safe: true };
}
