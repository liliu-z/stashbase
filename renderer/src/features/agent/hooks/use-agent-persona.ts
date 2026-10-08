/** The reader's persona library and the composer's view of it. */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { agentFailure } from '@/features/agent/application/failure-messages';
import type {
  AgentPersona,
  AgentPersonaInput,
  AgentPersonaPort,
} from '@/features/agent/application/ports';
import type { FailureView } from '@/shared/domain/feature-error';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

const LIBRARY_KEY = ['agent-personas'] as const;

/** A write shows at once, then the library re-reads so a list read that was
 *  already in flight cannot land over it. */
function settle(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: LIBRARY_KEY });
}

export interface AgentPersonaLibrary {
  readonly personas: readonly AgentPersona[];
  readonly loading: boolean;
  /** Adds a persona and answers it, or null when the library refused it. */
  add(input: AgentPersonaInput): Promise<AgentPersona | null>;
}

/**
 * The reader's persona library, one cache for every surface that reads it:
 * the composer's picker and the Gallery's Add both land here, so a persona
 * added in the Gallery is in the picker the moment the add answers.
 */
export function useAgentPersonaLibrary(port: AgentPersonaPort): AgentPersonaLibrary {
  const client = useQueryClient();
  const signalFor = useRequestSignals<'add'>();
  const library = useQuery({
    queryFn: ({ signal }) => port.list(signal),
    queryKey: LIBRARY_KEY,
    retry: false,
  });
  const add = useCallback(
    async (input: AgentPersonaInput) => {
      try {
        const created = await port.create(input, signalFor('add'));
        client.setQueryData<AgentPersona[]>(LIBRARY_KEY, (previous) => [
          ...(previous ?? []),
          created,
        ]);
        settle(client);
        return created;
      } catch {
        return null;
      }
    },
    [client, port, signalFor],
  );
  return { add, loading: library.isPending, personas: library.data ?? [] };
}

export interface AgentPersonaPicker {
  readonly personas: readonly AgentPersona[];
  /** The persona this Chat runs under, when it is still in the library. */
  readonly selected: AgentPersona | null;
  readonly failure: FailureView | null;
  readonly loading: boolean;
  readonly saving: boolean;
  /** Runs this Chat under a persona, or none. */
  choose(id: string | null): void;
  /** Creates a persona and runs it, or edits one. Answers whether it saved. */
  save(id: string | null, input: AgentPersonaInput): Promise<boolean>;
  /** Deletes a persona; a Chat running it falls back to none. */
  remove(id: string): Promise<boolean>;
  dismissFailure(): void;
}

/**
 * The composer's view of the library and of the active Chat's persona.
 *
 * `choose` belongs to the workspace: it runs the Chat under the persona and
 * makes it the project's choice for new Chats. A session reads its persona's
 * prompt when it starts, so editing the running persona calls `onEdited`,
 * which restarts the Chat on its own conversation.
 */
export function useAgentPersona(
  port: AgentPersonaPort,
  current: string | null,
  choose: (id: string | null) => void,
  onEdited: () => void,
): AgentPersonaPicker {
  const client = useQueryClient();
  const signalFor = useRequestSignals<'save' | 'remove'>();
  const library = useAgentPersonaLibrary(port);

  const write = useMutation({
    mutationFn: async ({ id, input }: { id: string | null; input: AgentPersonaInput }) =>
      id === null
        ? port.create(input, signalFor('save'))
        : port.update(id, input, signalFor('save')),
    onSuccess: (saved, { id }) => {
      client.setQueryData<AgentPersona[]>(LIBRARY_KEY, (previous = []) =>
        id === null
          ? [...previous, saved]
          : previous.map((persona) => (persona.id === saved.id ? saved : persona)),
      );
      settle(client);
    },
  });
  const drop = useMutation({
    mutationFn: (id: string) => port.remove(id, signalFor('remove')),
    onSuccess: (_result, id) => {
      client.setQueryData<AgentPersona[]>(LIBRARY_KEY, (previous = []) =>
        previous.filter((persona) => persona.id !== id),
      );
      settle(client);
    },
  });

  const saving = write.isPending || drop.isPending;
  const { mutateAsync: saveAsync, reset: resetWrite } = write;
  const { mutateAsync: removeAsync, reset: resetDrop } = drop;

  const save = useCallback(
    async (id: string | null, input: AgentPersonaInput) => {
      if (saving) return false;
      try {
        const saved = await saveAsync({ id, input });
        if (id === null) choose(saved.id);
        else if (id === current) onEdited();
        return true;
      } catch {
        return false;
      }
    },
    [choose, current, onEdited, saveAsync, saving],
  );

  const remove = useCallback(
    async (id: string) => {
      if (saving) return false;
      try {
        await removeAsync(id);
        if (id === current) choose(null);
        return true;
      } catch {
        return false;
      }
    },
    [choose, current, removeAsync, saving],
  );

  const failure = write.error ?? drop.error;
  return {
    choose,
    dismissFailure: () => {
      resetWrite();
      resetDrop();
    },
    failure: failure ? agentFailure(failure) : null,
    loading: library.loading,
    personas: library.personas,
    remove,
    save,
    saving,
    selected: library.personas.find((persona) => persona.id === current) ?? null,
  };
}
