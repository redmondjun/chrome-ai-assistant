import { getSettings } from './settings';
import { LEGACY_SETTINGS_KEY, LOCAL_SETTINGS_KEY } from '@/shared/storage';

describe('settings storage migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('moves legacy settings locally before removing the Chrome Sync copy', async () => {
    const local: Record<string, unknown> = {};
    const legacy = {
      model: { apiKey: 'nvapi-device-secret', useLocal: false },
      ui: { theme: 'dark' },
    };
    (chrome.storage.local.get as jest.Mock).mockImplementation(async key => {
      if (typeof key === 'string') return key in local ? { [key]: local[key] } : {};
      return { ...local };
    });
    (chrome.storage.local.set as jest.Mock).mockImplementation(async values => {
      Object.assign(local, values);
    });
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      [LEGACY_SETTINGS_KEY]: legacy,
    });
    (chrome.storage.sync.remove as jest.Mock).mockResolvedValue(undefined);

    const settings = await getSettings();

    expect(settings.model.apiKey).toBe('nvapi-device-secret');
    expect(settings.model.useLocal).toBe(false);
    expect(settings.ui.theme).toBe('dark');
    expect(local[LOCAL_SETTINGS_KEY]).toEqual(
      expect.objectContaining({
        model: expect.objectContaining(legacy.model),
        ui: expect.objectContaining(legacy.ui),
      })
    );
    expect(chrome.storage.sync.remove).toHaveBeenCalledWith(LEGACY_SETTINGS_KEY);
    expect((chrome.storage.local.set as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (chrome.storage.sync.remove as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('does not remove the legacy copy when the local write cannot be verified', async () => {
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({});
    (chrome.storage.local.set as jest.Mock).mockResolvedValue(undefined);
    (chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      [LEGACY_SETTINGS_KEY]: { model: { apiKey: 'secret' } },
    });

    await getSettings();

    expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
  });
});
