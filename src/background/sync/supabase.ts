import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AccountState, ChatConversation, ChatMessage, SyncStatus } from '@/shared/types';
import {
  ACCOUNT_STATE_KEY,
  ANONYMOUS_SCOPE,
  EMPTY_ACCOUNT_STATE,
  SYNC_STATUS_KEY,
  activeConversationKey,
  conversationKey,
} from '@/shared/storage';
import {
  applySyncedSettings,
  getSettings,
  getSettingsUpdatedAt,
  getSyncedSettings,
} from '../storage/settings';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const configured = Boolean(supabaseUrl && supabaseKey);

const chromeStorage = {
  async getItem(key: string) {
    const value = await chrome.storage.local.get(key);
    return value[key] ?? null;
  },
  async setItem(key: string, value: string) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string) {
    await chrome.storage.local.remove(key);
  },
};

let client: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  if (!configured || !supabaseUrl || !supabaseKey) {
    throw new Error('Supabase is not configured. Add the VITE_SUPABASE_* build variables.');
  }
  client ??= createClient(supabaseUrl, supabaseKey, {
    auth: {
      storage: chromeStorage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  });
  return client;
}

export async function initializeAccount(): Promise<void> {
  if (!configured) {
    await setAccountState({ configured: false, user: null });
    return;
  }
  if ((await getSettings()).privacy.localOnly) return;
  const { data, error } = await getClient().auth.getSession();
  if (error) throw error;
  await setAccountState(toAccountState(data.session?.user));
}

export async function getAccountState(): Promise<AccountState> {
  const stored = await chrome.storage.local.get(ACCOUNT_STATE_KEY);
  return stored[ACCOUNT_STATE_KEY] || { ...EMPTY_ACCOUNT_STATE, configured };
}

export async function signUp(email: string, password: string) {
  await assertCloudAllowed();
  const { data, error } = await getClient().auth.signUp({ email, password });
  if (error) throw error;
  if (data.session) await finishSignIn(data.session.user);
  return { needsVerification: !data.session };
}

export async function verifyEmail(email: string, token: string) {
  await assertCloudAllowed();
  const { data, error } = await getClient().auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
  if (!data.user) throw new Error('Email verification did not return a user.');
  await finishSignIn(data.user);
}

export async function signIn(email: string, password: string) {
  await assertCloudAllowed();
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  await finishSignIn(data.user);
}

export async function signInWithGoogle() {
  await assertCloudAllowed();
  const supabase = getClient();
  const redirectTo = chrome.identity.getRedirectURL('auth');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('Google sign-in did not return an authorization URL.');

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true });
  if (!responseUrl) throw new Error('Google sign-in was cancelled.');
  const callback = new URL(responseUrl);
  const oauthError = callback.searchParams.get('error_description');
  if (oauthError) throw new Error(oauthError);

  const code = callback.searchParams.get('code');
  if (code) {
    const { data: sessionData, error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
    if (!sessionData.user) throw new Error('Google sign-in did not return a user.');
    await finishSignIn(sessionData.user);
    return;
  }

  const fragment = new URLSearchParams(callback.hash.slice(1));
  const access_token = fragment.get('access_token');
  const refresh_token = fragment.get('refresh_token');
  if (!access_token || !refresh_token) throw new Error('Google sign-in callback was incomplete.');
  const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });
  if (sessionError) throw sessionError;
  if (!sessionData.user) throw new Error('Google sign-in did not return a user.');
  await finishSignIn(sessionData.user);
}

export async function requestRecovery(email: string) {
  await assertCloudAllowed();
  const { error } = await getClient().auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function verifyRecovery(email: string, token: string) {
  await assertCloudAllowed();
  const { error } = await getClient().auth.verifyOtp({
    email,
    token,
    type: 'recovery',
  });
  if (error) throw error;
}

export async function updatePassword(password: string) {
  await assertCloudAllowed();
  const { error } = await getClient().auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  const account = await getAccountState();
  if (configured) {
    const { error } = await getClient().auth.signOut({ scope: 'local' });
    if (error) throw error;
  }
  if (account.user) {
    await chrome.storage.local.remove([
      conversationKey(account.user.id),
      activeConversationKey(account.user.id),
    ]);
  }
  await setAccountState({ configured, user: null });
}

export async function pullSync(): Promise<ChatConversation[] | undefined> {
  const settings = await getSettings();
  if (settings.privacy.localOnly) {
    await setSyncStatus({ state: 'paused' });
    return;
  }
  const user = await requireUser();
  if (!user) return;
  await setSyncStatus({ state: 'syncing' });

  try {
    const supabase = getClient();
    const [conversationResult, messageResult, settingsResult] = await Promise.all([
      supabase.from('conversations').select('*').eq('user_id', user.id),
      supabase.from('messages').select('*').eq('user_id', user.id),
      supabase.from('user_settings').select('*').eq('user_id', user.id).maybeSingle(),
    ]);
    if (conversationResult.error) throw conversationResult.error;
    if (messageResult.error) throw messageResult.error;
    if (settingsResult.error) throw settingsResult.error;

    const local = await readConversations(user.id);
    const anonymous = await readConversations(ANONYMOUS_SCOPE);
    const remote = hydrateRemote(conversationResult.data || [], messageResult.data || []);
    const merged = mergeConversations([...local, ...anonymous], remote);

    await pushRows(user.id, merged);
    await writeConversations(user.id, merged);
    if (anonymous.length) {
      await chrome.storage.local.remove([
        conversationKey(ANONYMOUS_SCOPE),
        activeConversationKey(ANONYMOUS_SCOPE),
      ]);
    }

    const localSettingsUpdatedAt = await getSettingsUpdatedAt();
    const remoteSettingsUpdatedAt = Number(settingsResult.data?.updated_at || 0);
    if (settingsResult.data?.settings && remoteSettingsUpdatedAt >= localSettingsUpdatedAt) {
      await applySyncedSettings(settingsResult.data.settings, remoteSettingsUpdatedAt);
    } else {
      await pushSettings();
    }
    await setSyncStatus({ state: 'synced', lastSyncedAt: Date.now() });
    broadcast({ type: 'SYNC_DATA_CHANGED', scope: user.id, conversations: merged });
    return merged;
  } catch (error) {
    await setSyncStatus({ state: 'error', error: messageOf(error) });
    throw error;
  }
}

export async function pushConversations(conversations: ChatConversation[]) {
  if ((await getSettings()).privacy.localOnly) {
    await setSyncStatus({ state: 'paused' });
    return;
  }
  const user = await requireUser();
  if (!user) return;
  await setSyncStatus({ state: 'syncing' });
  try {
    await pushRows(user.id, conversations);
    await setSyncStatus({ state: 'synced', lastSyncedAt: Date.now() });
  } catch (error) {
    await setSyncStatus({ state: 'error', error: messageOf(error) });
    throw error;
  }
}

export async function pushSettings() {
  if ((await getSettings()).privacy.localOnly) {
    await setSyncStatus({ state: 'paused' });
    return;
  }
  const user = await requireUser();
  if (!user) return;
  const { error } = await getClient()
    .from('user_settings')
    .upsert({
      user_id: user.id,
      settings: await getSyncedSettings(),
      updated_at: (await getSettingsUpdatedAt()) || Date.now(),
    });
  if (error) throw error;
}

async function finishSignIn(user: { id: string; email?: string | null }) {
  const account = toAccountState(user);
  await setAccountState(account, false);
  try {
    await pullSync();
  } catch (error) {
    console.warn('[sync]', 'Initial account sync will be retried.', error);
  }
  broadcast({ type: 'ACCOUNT_STATE_CHANGED', account });
}

async function requireUser() {
  const state = await getAccountState();
  return state.user;
}

async function pushRows(userId: string, conversations: ChatConversation[]) {
  const stable = conversations.map(chat => ({
    ...chat,
    messages: chat.messages.filter(message => !message.isStreaming).slice(-100),
  }));
  if (!stable.length) return;
  const supabase = getClient();
  const { error: conversationError } = await supabase.from('conversations').upsert(
    stable.map(chat => ({
      id: chat.id,
      user_id: userId,
      title: chat.title,
      created_at: chat.createdAt,
      updated_at: chat.updatedAt,
    }))
  );
  if (conversationError) throw conversationError;

  const messages = stable.flatMap(chat =>
    chat.messages.map(message => ({
      id: message.id,
      user_id: userId,
      conversation_id: chat.id,
      payload: message,
      created_at: message.timestamp,
      updated_at: chat.updatedAt,
    }))
  );
  if (messages.length) {
    const { error } = await supabase.from('messages').upsert(messages);
    if (error) throw error;
  }
}

function hydrateRemote(conversationRows: any[], messageRows: any[]): ChatConversation[] {
  return conversationRows.map(row => ({
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messages: messageRows
      .filter(message => message.conversation_id === row.id)
      .map(message => message.payload as ChatMessage)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-100),
  }));
}

export function mergeConversations(
  local: ChatConversation[],
  remote: ChatConversation[]
): ChatConversation[] {
  const merged = new Map<string, ChatConversation>();
  for (const chat of [...remote, ...local]) {
    const existing = merged.get(chat.id);
    if (!existing) {
      merged.set(chat.id, { ...chat, messages: [...chat.messages] });
      continue;
    }
    const newer = chat.updatedAt >= existing.updatedAt ? chat : existing;
    const messages = new Map(existing.messages.map(message => [message.id, message]));
    for (const message of chat.messages) messages.set(message.id, message);
    merged.set(chat.id, {
      ...newer,
      messages: [...messages.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-100),
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readConversations(scope: string): Promise<ChatConversation[]> {
  const result = await chrome.storage.local.get(conversationKey(scope));
  return Array.isArray(result[conversationKey(scope)]) ? result[conversationKey(scope)] : [];
}

async function writeConversations(scope: string, conversations: ChatConversation[]) {
  await chrome.storage.local.set({ [conversationKey(scope)]: conversations });
}

function toAccountState(user?: { id: string; email?: string | null } | null): AccountState {
  return {
    configured,
    user: user ? { id: user.id, email: user.email || 'Signed-in user' } : null,
  };
}

async function setAccountState(state: AccountState, notify = true) {
  await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: state });
  if (notify) broadcast({ type: 'ACCOUNT_STATE_CHANGED', account: state });
}

async function setSyncStatus(status: SyncStatus) {
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
  broadcast({ type: 'SYNC_STATUS_CHANGED', status });
}

function broadcast(message: unknown) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function assertCloudAllowed() {
  if (!configured) throw new Error('Supabase is not configured for this build.');
  if ((await getSettings()).privacy.localOnly) {
    throw new Error('Account access and sync are paused while local-only mode is enabled.');
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
