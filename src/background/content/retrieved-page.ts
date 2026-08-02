import type { RetrievedPageRejectionReason } from '@/shared/types';

export type RetrievedPageValidation =
  | { valid: true }
  | {
      valid: false;
      reason: RetrievedPageRejectionReason;
      message: string;
    };

interface RetrievedPage {
  content: string;
  title?: string;
  url?: string;
}

export function validateRetrievedPage(page: RetrievedPage): RetrievedPageValidation {
  const content = page.content.trim();
  const title = page.title?.trim() || '';
  const url = page.url || '';
  const sample = `${title}\n${content.slice(0, 3000)}`;

  if (
    /(?:^|\/)(?:login|log-in|signin|sign-in|sso|saml|authenticate)(?:[/?#]|$)/i.test(url) ||
    /^(?:log in|sign in|single sign-on|authentication required)\b/i.test(title) ||
    /\b(?:please|you must|you need to)\s+(?:log|sign)\s+in\b/i.test(sample) ||
    /\bsign in to (?:continue|access|view)\b/i.test(sample)
  ) {
    return {
      valid: false,
      reason: 'authentication-required',
      message: 'The source returned an authentication page.',
    };
  }

  if (
    /\bHTTP (?:Status )?(?:401|403|4\d\d)\b/i.test(sample) ||
    /(?:^|\s)(?:401 Unauthorized|403 Forbidden)(?:\s|$)/i.test(sample)
  ) {
    return {
      valid: false,
      reason: 'http-error',
      message: 'The source returned an HTTP error page.',
    };
  }

  if (
    /\b(?:access denied|permission denied|forbidden)\b/i.test(sample) ||
    /\byou (?:do not|don['’]t) have permission to (?:access|view)\b/i.test(sample) ||
    /\brequest access\b/i.test(title)
  ) {
    return {
      valid: false,
      reason: 'access-denied',
      message: 'The source returned an access-denied page.',
    };
  }

  if (
    /\b(?:page not found|the page doesn['’]t exist|we can['’]t find that page|404 not found)\b/i.test(
      sample
    )
  ) {
    return {
      valid: false,
      reason: 'not-found',
      message: 'The source returned a page-not-found response.',
    };
  }

  if (
    /^(?:loading(?:\.\.\.)?|please wait(?:\.\.\.)?|enable javascript(?: to continue)?\.?)$/i.test(
      content
    ) ||
    /\byou need to enable javascript to run this app\b/i.test(sample)
  ) {
    return {
      valid: false,
      reason: 'empty-application-shell',
      message: 'The source returned an application shell without readable evidence.',
    };
  }

  return { valid: true };
}
