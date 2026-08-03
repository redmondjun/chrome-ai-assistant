import { validateRetrievedPage } from './retrieved-page';

describe('retrieved page validation', () => {
  it.each([
    {
      reason: 'authentication-required',
      page: {
        title: 'Sign in',
        url: 'https://example.com/login',
        content: 'Sign in to continue to the requested source.',
      },
    },
    {
      reason: 'access-denied',
      page: {
        title: 'Restricted document',
        url: 'https://example.com/document',
        content: 'You do not have permission to view this page.',
      },
    },
    {
      reason: 'http-error',
      page: {
        title: 'Server response',
        url: 'https://example.com/document',
        content: 'HTTP Status 403 Forbidden',
      },
    },
    {
      reason: 'not-found',
      page: {
        title: 'Missing',
        url: 'https://example.com/document',
        content: "Page Not Found. We can't find that page.",
      },
    },
    {
      reason: 'empty-application-shell',
      page: {
        title: 'Application',
        url: 'https://example.com/document',
        content: 'You need to enable JavaScript to run this app.',
      },
    },
  ])('rejects $reason pages', ({ page, reason }) => {
    expect(validateRetrievedPage(page)).toEqual(expect.objectContaining({ valid: false, reason }));
  });

  it('accepts ordinary readable evidence', () => {
    expect(
      validateRetrievedPage({
        title: 'Architecture decision',
        url: 'https://example.com/docs/architecture',
        content:
          'The team changed the message processing architecture to reduce latency and improve reliability.',
      })
    ).toEqual({ valid: true });
  });
});
