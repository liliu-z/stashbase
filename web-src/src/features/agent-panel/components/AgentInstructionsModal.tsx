import { useRef, type FormEvent } from 'react';
import { MAX_AGENT_INSTRUCTIONS_LENGTH } from '@shared/agent-instructions';
import type { AgentInstructionsScope } from '@/common/api/api';
import { ModalShell } from '@/common/components/ModalShell';
import { notifyAgentInstructionsSaved } from '@/common/lib/agentInstructionsTrigger';
import { Button } from '@/common/components/ui/button';
import { StatusMessage } from '@/common/components/ui/status';
import { Textarea } from '@/common/components/ui/textarea';
import { scopeDisplayName } from '@/common/lib/libraryScope';
import { useAgentInstructionsEditor } from '@/features/agent-panel/hooks/useAgentInstructionsEditor';

export function AgentInstructionsModal({
  scope,
  onCancel,
  onSaved,
}: {
  scope: AgentInstructionsScope;
  onCancel: () => void;
  onSaved?: (customized: boolean) => void;
}) {
  const editor = useAgentInstructionsEditor(scope);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeName = scopeDisplayName(scope);
  /* A cap this large is not a budget anyone writes against — it is a guard.
   * Showing the tally from character zero turns every visit into a form
   * with a quota; it earns its place only once running out is a real
   * prospect. */
  const nearLimit = editor.text.length >= MAX_AGENT_INSTRUCTIONS_LENGTH * 0.9;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await editor.save();
    if (saved) {
      onSaved?.(saved.customized);
      // Announce AFTER the write lands: a session that remounts on this
      // resolves its instructions by reading the store, so it has to read
      // what was just saved rather than what it is replacing.
      notifyAgentInstructionsSaved(scope);
      onCancel();
    }
  }

  return (
    <ModalShell
      title="Agent Instructions"
      /* Names the working directory and stops. The storage promise that used to ride
       * along here answered a question nobody had yet, on every open, in
       * the one line whose actual job is telling you WHICH scope you are
       * about to change. The scope name is emphasis, not a destination: in
       * accent it read as a link in the middle of a sentence, and nothing
       * happens when you press it.
       *
       * The FOLDER owns this, not the Chats — "guides every Chat in X" put
       * the conversation in the subject where the place belongs, and the
       * consequence people need is that walking into another folder means
       * other guidance. That is also why it reads like the `AGENTS.md`
       * people already know: a file in a directory, governing work done
       * there. Library retrieval scope deliberately has no editor: it is not
       * a working directory and receives the packaged default. */
      description={<>Agents working in <strong className="font-semibold text-foreground">{scopeName}</strong> follow this.</>}
      initialFocus={textareaRef}
      onCancel={editor.saving ? () => { /* wait for the config write */ } : onCancel}
      wide
    >
      <form onSubmit={submit}>
        <label htmlFor="agent-instructions-text" className="sr-only">Agent Instructions</label>
        <Textarea
          ref={textareaRef}
          id="agent-instructions-text"
          /* Prose, not code. Monospace framed this as configuration syntax
           * to get right, when what goes in it is a paragraph telling an
           * Agent what the folder is for. */
          className="min-h-48 text-sm leading-relaxed"
          /* Reached only by CLEARING the field, which is how a scope's
           * guidance is removed — so this is the empty state's caption, not
           * the teaching copy. The template does the teaching, as real text.
           * Re-showing it greyed out here would read as the thing you just
           * deleted coming back. */
          placeholder="Clear and save to restore the default instructions."
          value={editor.text}
          maxLength={MAX_AGENT_INSTRUCTIONS_LENGTH}
          disabled={editor.loading || editor.saving}
          onChange={(event) => editor.setText(event.target.value)}
        />
        {/* ONE line under the field, and it no longer describes a
          * limitation. Saving remounts the Chats already using this scope,
          * so the honest promise is the next message — not the next Chat,
          * which was a rule the entry point itself made impossible to
          * satisfy: the editor opens from a tab strip, so the Chat you
          * have open is always the one that used to miss out. */}
        <div className="mt-1.5 flex items-start justify-between gap-4 text-xs text-muted-foreground">
          <span>Applies from your next message. Clear and save to restore the default.</span>
          {nearLimit && (
            <span className="shrink-0 tabular-nums">
              {editor.text.length.toLocaleString()} / {MAX_AGENT_INSTRUCTIONS_LENGTH.toLocaleString()}
            </span>
          )}
        </div>
        {editor.error && <StatusMessage tone="error" className="mt-3 wrap-anywhere">{editor.error}</StatusMessage>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={editor.saving}>Cancel</Button>
          <Button type="submit" disabled={!editor.loaded || editor.loading || editor.saving}>{editor.saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </ModalShell>
  );
}
