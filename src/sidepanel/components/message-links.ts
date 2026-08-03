import type React from 'react';
import { evaluateLinkSafety } from '@/shared/link-safety';

export function handleAnswerLinkClick(event: React.MouseEvent<HTMLElement>) {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a');
  if (!(anchor instanceof HTMLAnchorElement)) return;

  let url: URL;
  try {
    url = new URL(anchor.href);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  event.preventDefault();
  const safety = evaluateLinkSafety({
    url: url.href,
    text: anchor.textContent || '',
    title: anchor.title,
  });
  if (!safety.safe) {
    console.warn('[chat]', 'blocked-unsafe-action', { url: url.href, reason: safety.reason });
    window.alert(
      `This link was blocked because it may perform an authenticated action.\n\n${safety.reason || ''}`
    );
    return;
  }
  void openAnswerLink(url.href);
}

async function openAnswerLink(url: string) {
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (error) {
    console.error('[chat]', 'Could not open answer link:', error);
  }
}
