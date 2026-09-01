import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  errorMessage,
  type EmbedderProvider,
  type EmbedderState,
  type HostedAccountState,
} from '@/common/api/api';
import { notifyAccountChanged } from '@/common/lib/accountEvents';
import { useAppActions } from '@/store/contexts/AppContext';

export interface EmbedderSettingsController {
  state: EmbedderState | null;
  loadError: string | null;
  retryLoad: () => void;
  selectedProvider: EmbedderProvider;
  selectProvider: (provider: EmbedderProvider) => void;
  /** The inline "Add key" field, used only while nothing is authorized. */
  addKey: string;
  addBusy: boolean;
  addError: string | null;
  setAddKey: (key: string) => void;
  submitAddKey: () => Promise<void>;
  /** A source or hosted-account request is running; related controls stay inert. */
  accountBusy: boolean;
  saveKey: (key: string) => Promise<void>;
  removeKey: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  signOut: () => Promise<void>;
  useAccountAllowance: () => Promise<void>;
  useApiKeySource: () => Promise<void>;
  applySignedIn: (account: HostedAccountState) => void;
}

/**
 * The Similarity Search panel's embedder state and every command that changes which
 * source is authorized: a bring-your-own key, the signed-in StashBase
 * allowance or neither.
 *
 * Every command that authorizes a source owes the rest of the
 * app the same three things — the shared `embedderHasKey` flag the search
 * popup and the Files callout gate on, a backfill mark when the server
 * started one, and an index-state refresh. `authorized` is that one
 * consequence, so a seventh command cannot half-apply it.
 *
 * Modal open/close stays with the panel: which dialog is up is a layout
 * question, and only the write behind it belongs here.
 */
export function useEmbedderSettings(): EmbedderSettingsController {
  const { dispatch, actions } = useAppActions();
  const [state, setState] = useState<EmbedderState | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<EmbedderProvider>('openai');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [addKey, setAddKey] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api.getEmbedder()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setSelectedProvider(s.provider);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg || 'Failed to load embedder settings');
      });
    return () => { cancelled = true; };
  }, [loadNonce]);

  const retryLoad = useCallback(() => setLoadNonce((n) => n + 1), []);

  const selectProvider = useCallback((provider: EmbedderProvider) => {
    setSelectedProvider(provider);
    setAddKey('');
    setAddError(null);
  }, []);

  /** What every newly authorized source owes the rest of the app. */
  const authorized = useCallback((opts: { backfillStarted?: boolean } = {}) => {
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: true });
    if (opts.backfillStarted) void actions.markVisibleFilesPendingForSearch();
    void actions.refreshIndexState();
  }, [dispatch, actions]);

  const applyKeyResult = useCallback((result: Awaited<ReturnType<typeof api.changeApiKey>>) => {
    setState((s) => (s ? { ...s, provider: result.provider, model: result.model, hasKey: true, authorized: true, source: result.provider } : s));
    setSelectedProvider(result.provider);
    authorized({ backfillStarted: result.backfillStarted });
    if (result.warning) actions.toast(`API key saved, but validation could not reach the provider: ${result.warning}`, { level: 'warning' });
  }, [authorized, actions]);

  const saveKey = useCallback(async (key: string) => {
    const result = await api.changeApiKey(key, selectedProvider);
    if (!mountedRef.current) return;
    applyKeyResult(result);
  }, [selectedProvider, applyKeyResult]);

  const submitAddKey = useCallback(async () => {
    const trimmed = addKey.trim();
    if (!trimmed) { setAddError('Key required'); return; }
    setAddBusy(true);
    setAddError(null);
    try {
      // changeApiKey rejects definite provider auth failures server-side,
      // so the success path only does one validation round trip.
      const result = await api.changeApiKey(trimmed, selectedProvider);
      if (!mountedRef.current) return;
      setAddKey('');
      applyKeyResult(result);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setAddError(errorMessage(err));
    } finally {
      if (mountedRef.current) setAddBusy(false);
    }
  }, [addKey, selectedProvider, applyKeyResult]);

  const removeKey = useCallback(async () => {
    await api.removeApiKey();
    if (!mountedRef.current) return;
    setLoadNonce((n) => n + 1);
    // The search popup re-checks the embedder before every semantic run, so
    // flipping the shared key state here is all it needs.
    dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: false });
    void actions.refreshIndexState();
  }, [dispatch, actions]);

  const refreshAccount = useCallback(async () => {
    setAccountBusy(true);
    try {
      const account = await api.getAccount(true);
      if (mountedRef.current) setState((current) => current ? { ...current, account } : current);
    } catch (err: unknown) {
      actions.toast(errorMessage(err), { level: 'error' });
    } finally {
      if (mountedRef.current) setAccountBusy(false);
    }
  }, [actions]);

  const signOut = useCallback(async () => {
    setAccountBusy(true);
    try {
      await api.signOutAccount();
      notifyAccountChanged();
      if (!mountedRef.current) return;
      setLoadNonce((n) => n + 1);
      dispatch({ type: 'EMBEDDER_KEY_STATE', hasKey: false });
      void actions.refreshIndexState();
    } catch (err: unknown) {
      actions.toast(errorMessage(err), { level: 'error' });
    } finally {
      if (mountedRef.current) setAccountBusy(false);
    }
  }, [dispatch, actions]);

  const useAccountAllowance = useCallback(async () => {
    setAccountBusy(true);
    try {
      const account = await api.useAccountAllowance();
      if (!mountedRef.current) return;
      setState((current) => current ? { ...current, source: 'stashbase-account', authorized: true, account } : current);
      authorized({ backfillStarted: account.backfillStarted });
    } catch (err: unknown) {
      actions.toast(errorMessage(err), { level: 'error' });
    } finally {
      if (mountedRef.current) setAccountBusy(false);
    }
  }, [authorized, actions]);

  const useApiKeySource = useCallback(async () => {
    setAccountBusy(true);
    try {
      const next = await api.useEmbeddingSource(selectedProvider);
      if (!mountedRef.current) return;
      setState(next);
      authorized({ backfillStarted: next.backfillStarted });
    } catch (err: unknown) {
      actions.toast(errorMessage(err), { level: 'error' });
    } finally {
      if (mountedRef.current) setAccountBusy(false);
    }
  }, [selectedProvider, authorized, actions]);

  const applySignedIn = useCallback((account: HostedAccountState) => {
    setState((current) => current ? { ...current, authorized: true, source: 'stashbase-account', account } : current);
    // No backfill mark: sign-in resolves through `GET /api/account`, which
    // does not report whether activating the account started one. The
    // server computes that flag on the OAuth path but keeps it out of every
    // response the renderer reads — see the Known Gap on
    // `HostedAccountActivation` in `shared/account.ts`.
    authorized();
  }, [authorized]);

  return {
    state,
    loadError,
    retryLoad,
    selectedProvider,
    selectProvider,
    addKey,
    addBusy,
    addError,
    setAddKey,
    submitAddKey,
    accountBusy,
    saveKey,
    removeKey,
    refreshAccount,
    signOut,
    useAccountAllowance,
    useApiKeySource,
    applySignedIn,
  };
}
