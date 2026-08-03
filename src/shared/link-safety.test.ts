import { evaluateLinkSafety } from './link-safety';

describe('evaluateLinkSafety', () => {
  it.each([
    [{ url: 'https://stash.example.com/plugins/servlet/createBranch?issue=SQ-1' }],
    [{ url: 'https://jira.example.com/browse/SQ-1', text: 'Create branch' }],
    [{ url: 'https://jira.example.com/browse/SQ-1', text: 'Create PR' }],
    [{ url: 'https://jira.example.com/browse/SQ-1', title: 'Delete issue' }],
    [
      {
        url: 'https://jira.example.com/browse/SQ-1',
        context: 'Use this action to merge pull request',
      },
    ],
  ])('blocks authenticated action links', link => {
    expect(evaluateLinkSafety(link)).toEqual(
      expect.objectContaining({ safe: false, reason: expect.any(String) })
    );
  });

  it.each([
    { url: 'https://jira.example.com/browse/SQ-1', text: 'SQ-1 Improve search' },
    { url: 'https://wiki.example.com/display/TEAM/Architecture', text: 'Architecture' },
    {
      url: 'https://stash.example.com/projects/P/repos/app/pull-requests/42/overview',
      text: 'PR 42',
    },
    { url: 'https://docs.example.com/close-reading', text: 'Close reading guide' },
  ])('allows read-only sources', link => {
    expect(evaluateLinkSafety(link)).toEqual({ safe: true });
  });
});
