import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { DependencyProvider } from '@/app/composition/dependency-context';
import {
  ProjectWelcome,
  useProjectEntry,
  type WorkspaceSessionController,
} from '@/features/workspace/public';
import { createWorkspaceSessionRuntime } from '@/features/workspace/test-support';
import type { WorkspaceNotice } from '@/shared/domain/workspace-notice';
import { appDependencies } from '@/test/fakes/app';
import { sessionPersistence } from '@/test/fakes/workspace';
import { createTestQueryClient, queryWrapper } from '@/test/query';

import { WorkspaceLayout, type WorkspaceComposition } from './workspace-layout';
import { WorkspaceNotices } from './workspace-notices';

afterEach(cleanup);

function session(
  status: WorkspaceSessionController['status'] = { kind: 'ready', restoredFolder: null },
): WorkspaceSessionController {
  return {
    mathMode: false,
    runtime: createWorkspaceSessionRuntime(sessionPersistence()),
    shell: { agentPaneWidth: 576, sidebarOpen: true, sidebarWidth: 300 },
    status,
  };
}

function mount(overrides: Partial<WorkspaceComposition> = {}) {
  const dependencies = appDependencies();
  const active = overrides.session ?? session();
  function Welcome() {
    const entry = useProjectEntry(
      dependencies.project.folderPicker,
      dependencies.project.lifecycle,
      dependencies.workspace.adapters.githubImport,
    );
    return (
      <ProjectWelcome
        {...dependencies.project}
        entry={entry}
        isRestoringSession={active.status.kind === 'restoring'}
      />
    );
  }
  const composition: WorkspaceComposition = {
    dialogs: <div data-testid="dialogs" />,
    floatingNotices: null,
    hasActiveFolder: true,
    notices: null,
    panes: <div data-testid="panes" />,
    session: active,
    sidebar: <div data-testid="sidebar" />,
    started: true,
    titlebar: <div data-testid="titlebar" />,
    // Bound the way the shell binds it, so the layout is exercised with the
    // welcome it is actually handed.
    welcome: <Welcome />,
    ...overrides,
  };
  const Wrapper = queryWrapper(createTestQueryClient());
  return render(
    <Wrapper>
      <DependencyProvider dependencies={dependencies}>
        <WorkspaceLayout {...composition} />
      </DependencyProvider>
    </Wrapper>,
  );
}

describe('workspace layout', () => {
  it('puts every bound region on screen once', () => {
    mount();

    for (const region of ['dialogs', 'sidebar', 'titlebar', 'panes']) {
      expect(screen.getByTestId(region)).not.toBeNull();
    }
  });

  it('holds the workspace back until the window has started', () => {
    mount({ started: false });

    expect(screen.queryByTestId('panes')).toBeNull();
    // The chrome the reader can act on is up before the workspace is.
    expect(screen.getByTestId('sidebar')).not.toBeNull();
    expect(screen.getByTestId('titlebar')).not.toBeNull();
  });

  it('keeps the panes mounted but hidden while no folder is open', () => {
    mount({ hasActiveFolder: false });

    // Mounted, so the Agent keeps its transcript across a folder change, and
    // out of the accessibility tree, so the welcome has the section to itself.
    expect(screen.getByTestId('panes').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a notice and offers the dismissal it carries', async () => {
    const onDismiss = vi.fn();
    const notices: WorkspaceNotice[] = [
      {
        action: null,
        dismissLabel: 'Dismiss',
        message: 'Preparation was refused.',
        onDismiss,
        tone: 'input',
      },
      {
        action: null,
        dismissLabel: 'Dismiss',
        message: 'The host lost this folder.',
        onDismiss: null,
        tone: 'capability',
      },
    ];
    mount({ notices: <WorkspaceNotices notices={notices} /> });

    // What the reader can correct interrupts; a capability that could not
    // answer is said quietly.
    expect(screen.getByRole('alert').textContent).toBe('Preparation was refused.');
    expect(screen.getByRole('status').textContent).toBe('The host lost this folder.');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('holds the welcome back while a saved session is still reopening', () => {
    mount({ hasActiveFolder: false, session: session({ kind: 'restoring' }), started: false });

    // Nothing invites the reader to add a folder while one is being reopened.
    expect(screen.queryByRole('button', { name: /add folder/iu })).toBeNull();
  });
});
