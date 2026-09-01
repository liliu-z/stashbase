/**
 * Embedding key entry modal. The caller persists through
 * `/api/embedder/key`, which rejects definite provider auth failures
 * before writing config.
 * `mode='change'` only swaps the title + button text.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { EmbedderProvider } from '@/common/api/api';
import { errorMessage } from '@/common/api/api';
import { ModalShell } from '@/common/components/ModalShell';
import { Button } from '@/common/components/ui/button';
import { Input } from '@/common/components/ui/input';
import { StatusMessage } from '@/common/components/ui/status';

export function KeyModal({
  mode = 'enter',
  provider,
  model,
  placeholder,
  onCancel,
  onSaved,
}: {
  mode?: 'enter' | 'change';
  provider: EmbedderProvider;
  model: string;
  placeholder: string;
  onCancel: () => void;
  onSaved: (key: string) => void | Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) { setError('Key required'); return; }
    setBusy(true);
    setError(null);
    try {
      // The caller saves via changeApiKey, whose server route rejects
      // definite provider auth failures; don't preflight here or successful
      // saves pay for two validation calls.
      await onSaved(trimmed);
    } catch (err: unknown) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={mode === 'change' ? 'Change API key' : `${providerLabel(provider)} API key`}
      description={mode === 'change'
        ? `Replaces your ${providerLabel(provider)} key for ${model}.`
        : `Used only for Similarity Search with ${model} — never for Chat or completions.`}
      initialFocus={inputRef}
      onCancel={onCancel}
    >
      {/* One field and one confirm action is exactly the shape a `form`
        * exists for: Enter now submits through the browser's implicit
        * submission rather than through a keydown branch that had to spell
        * its own preventDefault. `type="submit"` is explicit because Base
        * UI's `useButton` writes `type="button"` on every Button, so the
        * confirm action would otherwise sit in the form doing nothing.
        * There is no visible label — the dialog title names the field —
        * so `aria-label` carries the name. */}
      <form onSubmit={submit}>
        <Input
          ref={inputRef}
          type="password"
          className="font-mono text-sm"
          aria-label={mode === 'change' ? 'New API key' : `${providerLabel(provider)} API key`}
          placeholder={placeholder}
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error && (
          <StatusMessage tone="error" className="mt-2.5 max-h-overlay-xs overflow-y-auto wrap-anywhere">
            {error}
          </StatusMessage>
        )}
        <div className="mt-3.5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy}
          >{busy ? 'Validating…' : (mode === 'change' ? 'Save' : 'Continue')}</Button>
        </div>
      </form>
    </ModalShell>
  );
}

function providerLabel(provider: EmbedderProvider): string {
  return provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
}
