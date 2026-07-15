import { shouldFollowLinks } from './classifier';

describe('shouldFollowLinks', () => {
  it('proactively researches links for generation tasks even when the model says no', async () => {
    const router = {
      complete: jest.fn().mockResolvedValue({ text: 'no' }),
    };

    await expect(
      shouldFollowLinks(router as any, 'Generate an accomplishments summary from this evidence', 5)
    ).resolves.toBe(true);
  });
});
