import { useEffect, useState } from 'react';
import { api, errorMessage, type AgentInstructionsScope } from '@/common/api/api';

/** Lightweight toolbar status for the active scope. This stays separate from
 * the editor so the persistent launcher can be informative without keeping a
 * dialog controller mounted. */
export function useAgentInstructionsPresence(scope: AgentInstructionsScope | null) {
  const [customized, setCustomized] = useState<boolean | null>(null);
  const folderPath = scope?.path ?? null;

  useEffect(() => {
    let current = true;
    setCustomized(null);
    if (!folderPath) return () => { current = false; };
    const requestScope: AgentInstructionsScope = { kind: 'folder', path: folderPath };
    void api.getAgentInstructions(requestScope).then((state) => {
      if (current) setCustomized(state.customized);
    }).catch(() => {
      if (current) setCustomized(null);
    });
    return () => { current = false; };
  }, [folderPath]);

  return { customized, setCustomized };
}

/** Controller boundary for the Agent Instructions dialog. Components render
 * state; this hook owns API access, stale-load fencing, and save errors. */
export function useAgentInstructionsEditor(scope: AgentInstructionsScope) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoaded(false);
    setError(null);
    void api.getAgentInstructions(scope).then((state) => {
      if (!current) return;
      setText(state.text);
      setLoaded(true);
      setLoading(false);
    }).catch((err: unknown) => {
      if (!current) return;
      setError(errorMessage(err));
      setLoading(false);
    });
    return () => { current = false; };
  }, [scope]);

  async function save() {
    if (!loaded) return null;
    setSaving(true);
    setError(null);
    try {
      const state = await api.setAgentInstructions(scope, text);
      setText(state.text);
      return state;
    } catch (err: unknown) {
      setError(errorMessage(err));
      setSaving(false);
      return null;
    }
  }

  return { text, setText, loading, loaded, saving, error, save };
}
