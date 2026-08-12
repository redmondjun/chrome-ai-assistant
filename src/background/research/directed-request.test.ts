import {
  collectExcludedTicketIds,
  parseDirectedResearchRequest,
  resolveDirectedResearchRequest,
} from './directed-request';

describe('directed research requests', () => {
  it('parses the exported first-100-ticket request and its grounding URL', () => {
    const request = parseDirectedResearchRequest(
      'visit first 100 the tickets from https://wiki.example.com/Jira+ticket+tracking and fill qualifications here: https://wiki.example.com/Promotion+Plan; skip the tickets are already on the qualifications'
    );

    expect(request).toEqual({
      selection: {
        kind: 'ticket',
        sourceUrl: 'https://wiki.example.com/Jira+ticket+tracking',
        requestedCount: 100,
      },
      explicitUrls: [
        'https://wiki.example.com/Jira+ticket+tracking',
        'https://wiki.example.com/Promotion+Plan',
      ],
      skipExisting: true,
    });
  });

  it('collects existing ticket IDs from grounding text and links', () => {
    expect(
      collectExcludedTicketIds([
        {
          id: 'plan',
          url: 'https://wiki.example.com/plan',
          title: 'Plan',
          text: 'Existing rows SQ-1 and CA-2',
          links: [
            {
              url: 'https://jira.example.com/browse/SQ-3',
              text: 'supporting ticket',
              isExternal: true,
            },
          ],
          capturedAt: 1,
        },
      ])
    ).toEqual(['SQ-1', 'CA-2', 'SQ-3']);
  });

  it('loads the tracking URL as the subject source and keeps the active plan as grounding', async () => {
    const current = {
      url: 'https://wiki.example.com/Promotion+Plan',
      title: 'Promotion Plan',
      text: 'Qualification | Accomplishments Summary | Supporting Documentation\nSQ-1',
      links: [],
      meta: {},
      timestamp: 1,
    };
    const fetchPage = jest.fn().mockResolvedValue({
      url: 'https://wiki.example.com/Jira+ticket+tracking',
      title: 'Ticket tracking',
      text: 'Tracked tickets',
      links: [],
      meta: {},
      timestamp: 2,
    });

    const resolved = await resolveDirectedResearchRequest(
      current,
      [],
      'visit first 100 tickets from https://wiki.example.com/Jira+ticket+tracking and fill qualifications here: https://wiki.example.com/Promotion+Plan; skip tickets already in qualifications',
      fetchPage
    );

    expect(fetchPage).toHaveBeenCalledWith('https://wiki.example.com/Jira+ticket+tracking');
    expect(resolved.content.title).toBe('Ticket tracking');
    expect(resolved.contextPages).toEqual([expect.objectContaining({ title: 'Promotion Plan' })]);
    expect(resolved.subjectSelection?.excludedTicketIds).toEqual(['SQ-1']);
  });
});
