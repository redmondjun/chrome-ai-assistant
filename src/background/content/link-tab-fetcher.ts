import { getTabContent } from './tab-content';
import { validateRetrievedPage } from './retrieved-page';
import { evaluateLinkSafety } from '@/shared/link-safety';
import type { LinkInfo, RetrievedPageRejectionReason, TabContent } from '@/shared/types';

const LOAD_TIMEOUT_MS = 20000;
const CONTENT_TIMEOUT_MS = 10000;
const CONTENT_POLL_MS = 400;
const STABLE_READS_REQUIRED = 2;
const MIN_CONTENT_SETTLE_MS = 1600;

export interface LinkTabFetchResult {
  content?: string;
  links?: LinkInfo[];
  finalUrl?: string;
  title?: string;
  error?: string;
  failureReason?: RetrievedPageRejectionReason;
}

export async function fetchLinkContentInTab(
  url: string,
  signal?: AbortSignal
): Promise<LinkTabFetchResult> {
  const safety = evaluateLinkSafety({ url });
  if (!safety.safe) {
    console.warn('[research]', 'blocked-unsafe-action', { url, reason: safety.reason });
    return { error: `Blocked unsafe action URL. ${safety.reason || ''}`.trim() };
  }
  let tabId: number | undefined;

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return { error: 'Chrome did not create a tab for this source.' };

    await waitForTabLoad(tabId, tab.status, signal);
    const content = await waitForReadableContent(tabId, signal);
    if (isAuthenticationPage(url, content.url, content.title)) {
      return {
        error: `The source redirected to an authentication page: ${content.title} (${content.url})`,
        failureReason: 'authentication-required',
      };
    }
    const text = content.text.trim();
    if (!text) {
      return {
        error: `The authenticated tab loaded ${content.title} (${content.url}) but no readable text appeared within ${CONTENT_TIMEOUT_MS / 1000} seconds.`,
      };
    }
    const validation = validateRetrievedPage({
      content: text,
      title: content.title,
      url: content.url,
    });
    if (!validation.valid) {
      return {
        error: validation.message,
        failureReason: validation.reason,
      };
    }

    return {
      content: text.slice(0, 15000),
      links: content.links,
      finalUrl: content.url,
      title: content.title,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      error: `Authenticated browser-tab extraction failed: ${toErrorMessage(error)}`,
    };
  } finally {
    if (tabId !== undefined) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (error) {
        console.warn('Could not close temporary source tab:', error);
      }
    }
  }
}

async function waitForReadableContent(tabId: number, signal?: AbortSignal): Promise<TabContent> {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  const minimumReadyAt = Date.now() + MIN_CONTENT_SETTLE_MS;
  let latest = await getTabContent(tabId);
  let previousFingerprint = '';
  let stableReads = 0;

  while (Date.now() < deadline) {
    const fingerprint = `${latest.url}\n${latest.title}\n${latest.text.trim()}`;
    stableReads = fingerprint === previousFingerprint ? stableReads + 1 : 0;
    if (
      Date.now() >= minimumReadyAt &&
      latest.text.trim().length >= 20 &&
      stableReads >= STABLE_READS_REQUIRED
    )
      break;
    previousFingerprint = fingerprint;
    await delay(CONTENT_POLL_MS, signal);
    latest = await getTabContent(tabId);
  }

  return latest;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function waitForTabLoad(tabId: number, status?: string, signal?: AbortSignal): Promise<void> {
  if (status === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for tab ${tabId} to load.`));
    }, LOAD_TIMEOUT_MS);

    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    signal?.addEventListener(
      'abort',
      () => {
        cleanup();
        reject(signal.reason);
      },
      { once: true }
    );

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationPage(requestedUrl: string, loadedUrl: string, title: string): boolean {
  const requestedHost = new URL(requestedUrl).hostname;
  const loaded = new URL(loadedUrl);
  const authText = `${loaded.pathname} ${loaded.search} ${title}`;
  return (
    (loaded.hostname !== requestedHost && /(?:login|signin|sso|saml|auth)/i.test(authText)) ||
    /^(?:log in|sign in|single sign-on)\b/i.test(title.trim())
  );
}
