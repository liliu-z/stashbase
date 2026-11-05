/** A single entry operation keeps source selection, acquisition, cancellation,
 * and retry state together. Window allocation remains the desktop's authority. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import {
  projectEntryFailure,
  projectFailureMessage,
} from '@/features/workspace/application/failure-messages';
import {
  ProjectImportError,
  type GitHubImportPort,
  type ProjectFolderPickerPort,
  type ProjectLifecyclePort,
} from '@/features/workspace/application/ports';
import { workspaceQueryKeys } from '@/features/workspace/application/queries';
import type { FailureView } from '@/shared/domain/feature-error';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';

export interface GitHubImportView {
  folderName: string;
  /** The directory the copy is created in: the reader's choice, otherwise
   *  where the last copy went, otherwise the folder home. */
  location: string | null;
  /** The Gallery entry being copied. Its repository is fixed, so the URL is
   *  not the reader's to see or change; null for an import from GitHub. */
  source: string | null;
  nameIssue: string | null;
  urlIssue: string | null;
  failure: FailureView | null;
  canSubmit: boolean;
  pending: boolean;
  url: string;
  retainedPath: string | null;
  existingPath: string | null;
  inputLocked: boolean;
  checkingOutcome: boolean;
  cancel(): void;
  chooseLocation(): void;
  setFolderName(next: string): void;
  setUrl(next: string): void;
  submit(): void;
  openExisting(): void;
  startAnotherCopy(): void;
}

type Request = { kind: 'open' | 'create' | 'copy' } | { kind: 'select'; path: string };
type Draft = {
  url: string;
  name: string | null;
  location: string | null;
  path: string | null;
  source: string | null;
  unknown: boolean;
};
const emptyDraft: Draft = {
  url: '',
  name: null,
  location: null,
  path: null,
  source: null,
  unknown: false,
};
const COPY_LOCATION_KEY = ['project', 'copy-location'] as const;

/** One user operation per window, from acquisition through workspace readiness.
 * A retained path is a completed acquisition, so Retry cannot download it again. */
export function useProjectEntry(
  picker: ProjectFolderPickerPort,
  lifecycle: ProjectLifecyclePort,
  importer: GitHubImportPort,
): ProjectEntry {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<Request | null>(null);
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const remembered = useQuery({
    queryKey: COPY_LOCATION_KEY,
    queryFn: ({ signal }) => importer.location(signal),
    enabled: dialogOpen,
    retry: false,
  });
  const signalFor = useRequestSignals<'entry'>();
  const operation = useRef<AbortSignal | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      operation.current = null;
      mounted.current = false;
    };
  }, []);

  const run = async (request: Request, copy = draft, homeDirectory?: string) => {
    if (operation.current) return;
    const signal = signalFor('entry');
    operation.current = signal;
    setPendingRequest(request);
    setFailure(null);
    setConflict(null);
    let acquired = request.kind === 'copy' ? copy.path : null;
    try {
      let path: string;
      if (request.kind === 'copy') {
        if (!acquired) {
          const parsed = importer.readUrl(copy.url);
          const name = copy.name ?? (parsed.ok ? parsed.folderName : '');
          const location = copy.location ?? remembered.data ?? null;
          if (!parsed.ok || !name || importer.folderNameIssue(name) || !location) return;
          acquired = await importer.run(copy.url, name, location, signal);
          // The next copy starts where this one went.
          void cache.invalidateQueries({ queryKey: COPY_LOCATION_KEY });
          // Even if Cancel won the race with the response, remember committed
          // files. Cancellation stops entry, not ownership of those files.
          if (mounted.current && operation.current === signal)
            setDraft({ ...copy, location, name, path: acquired, unknown: false });
        }
        path = acquired;
      } else if (request.kind === 'select') path = request.path;
      else {
        const chosen = await picker.chooseFolder(
          homeDirectory ? { defaultPath: homeDirectory } : undefined,
        );
        if (chosen.status === 'cancelled') return;
        if (chosen.status === 'failed') {
          setFailure({
            tone: 'capability',
            message: projectFailureMessage(chosen.failure.kind, 'opened'),
          });
          return;
        }
        path = chosen.folderPath;
      }
      if (signal.aborted) return;
      await lifecycle.enterFolder(path, signal);
      if (mounted.current && operation.current === signal && !signal.aborted) {
        setDialogOpen(false);
        if (request.kind === 'copy') setDraft(emptyDraft);
      }
    } catch (error) {
      if (!mounted.current || operation.current !== signal) return;
      if (error instanceof ProjectImportError) {
        setDraft((current) => ({ ...current, unknown: error.outcome === 'unknown' }));
        if (signal.aborted) return;
        setConflict(error.destination?.directory ? error.destination.path : null);
        setFailure(projectEntryFailure(error, acquired));
      } else if (!signal.aborted) {
        setFailure(projectEntryFailure(error, acquired));
      }
    } finally {
      // Refresh membership even after cancellation or a failed window handoff.
      void cache.invalidateQueries({ queryKey: workspaceQueryKeys.project });
      if (operation.current === signal) operation.current = null;
      if (mounted.current) setPendingRequest(null);
    }
  };
  const parsed = importer.readUrl(draft.url);
  const folderName = draft.name ?? (parsed.ok ? parsed.folderName : '');
  const nameIssue = folderName ? importer.folderNameIssue(folderName) : null;
  const location = draft.location ?? remembered.data ?? null;
  const inputLocked = !!pendingRequest || !!draft.path || draft.unknown;
  const cancel = () => {
    signalFor('entry');
    setFailure(null);
    setDialogOpen(false);
  };
  const request: GitHubImportView = {
    url: draft.url,
    folderName,
    location,
    source: draft.source,
    nameIssue,
    urlIssue: draft.url.trim() && !parsed.ok ? parsed.message : null,
    failure,
    retainedPath: draft.path,
    existingPath: conflict,
    inputLocked,
    checkingOutcome: draft.unknown,
    pending: pendingRequest !== null,
    canSubmit:
      !pendingRequest &&
      (draft.path !== null || (parsed.ok && !!folderName && !nameIssue && !!location)),
    cancel,
    chooseLocation: () => {
      if (inputLocked) return;
      void (async () => {
        const chosen = await picker.chooseFolder(location ? { defaultPath: location } : undefined);
        if (!mounted.current || chosen.status === 'cancelled') return;
        if (chosen.status === 'failed') {
          setFailure({
            tone: 'capability',
            message: 'The folder picker is unavailable, so the location was not changed.',
          });
          return;
        }
        // The choice arrives after the picker closes; a copy that started or
        // settled meanwhile keeps the location it was made in.
        setDraft((current) =>
          current.path || current.unknown ? current : { ...current, location: chosen.folderPath },
        );
        setFailure(null);
        setConflict(null);
      })();
    },
    setUrl: (url) => {
      if (!operation.current && !draft.path && !draft.unknown) {
        setDraft({ ...draft, url });
        setFailure(null);
        setConflict(null);
      }
    },
    startAnotherCopy: () => {
      if (operation.current) return;
      // A Gallery entry's repository is not on screen to type again, so its
      // next copy keeps the source, name and location for the reader to adjust.
      setDraft(
        draft.source
          ? {
              ...emptyDraft,
              location: draft.location,
              name: draft.name,
              source: draft.source,
              url: draft.url,
            }
          : emptyDraft,
      );
      setFailure(null);
      setConflict(null);
    },
    setFolderName: (name) => {
      if (!operation.current && !draft.path && !draft.unknown) {
        setDraft({ ...draft, name });
        setFailure(null);
        setConflict(null);
      }
    },
    submit: () => {
      void run({ kind: 'copy' });
    },
    openExisting: () => {
      if (conflict) {
        const next = { ...draft, path: conflict };
        setDraft(next);
        void run({ kind: 'copy' }, next);
      }
    },
  };
  return {
    failure: dialogOpen ? null : (failure?.message ?? null),
    isPending: pendingRequest !== null,
    pendingRequest,
    create: (directory: string) => {
      void run({ kind: 'create' }, draft, directory);
    },
    open: () => {
      void run({ kind: 'open' });
    },
    select: (path: string) => {
      void run({ kind: 'select', path });
    },
    importDialog: {
      open: dialogOpen,
      request,
      close: cancel,
      start: () => {
        if (!operation.current) {
          // An unconfirmed Gallery copy is not an import someone began; a
          // retained or unknown one still has to be settled first.
          if (draft.source && !draft.path && !draft.unknown) setDraft(emptyDraft);
          setDialogOpen(true);
          setFailure(null);
        }
      },
    },
    // A Gallery copy waits for the reader to confirm its name and location;
    // nothing is downloaded until they do.
    copy: (source: { repo: string; name: string }) => {
      if (operation.current) return;
      // An unresolved receipt must be settled before starting another copy.
      if (draft.unknown) {
        setDialogOpen(true);
        return;
      }
      const derived = importer.readUrl(source.repo);
      const name =
        importer.folderNameIssue(source.name) === null
          ? source.name
          : derived.ok
            ? derived.folderName
            : source.name;
      const next =
        draft.url === source.repo && draft.name === name && draft.path
          ? draft
          : { ...emptyDraft, name, source: source.name, url: source.repo };
      setDraft(next);
      setFailure(null);
      setConflict(null);
      setDialogOpen(true);
    },
  };
}

export interface ProjectEntry {
  failure: string | null;
  isPending: boolean;
  pendingRequest: Request | null;
  create(homeDirectory: string): void;
  open(): void;
  select(path: string): void;
  copy(source: { repo: string; name: string }): void;
  importDialog: {
    open: boolean;
    request: GitHubImportView;
    close(): void;
    start(): void;
  };
}
