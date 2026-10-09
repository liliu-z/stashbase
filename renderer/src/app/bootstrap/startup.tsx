import { createRoot, type Root } from 'react-dom/client';

import type { AppDependencies } from '@/app/dependencies';
import { Providers } from '@/app/providers';
import { App } from '@/app/shell';
import { applyAppearanceSurface } from '@/shared/runtime/appearance-surface';

import { StartupFailure } from './startup-failure';

type DependencyFactory = () => AppDependencies;

export function mountApplication(
  rootElement: HTMLElement,
  createDependencies: DependencyFactory,
): Root {
  let dependencies: AppDependencies | undefined;
  const report = (error: unknown) => {
    dependencies?.reportError?.(error, 'render');
    console.error(error);
  };
  const root = createRoot(rootElement, {
    onCaughtError: report,
    onUncaughtError: report,
    onRecoverableError: report,
  });
  try {
    dependencies = createDependencies();
    // The appearance the desktop remembered paints the first frame; the
    // Settings read reconciles it once it answers.
    if (dependencies.initialAppearance) applyAppearanceSurface(dependencies.initialAppearance);
    root.render(
      <Providers reportError={dependencies.reportError}>
        <App dependencies={dependencies} />
      </Providers>,
    );
  } catch (cause) {
    dependencies?.reportError?.(cause, 'startup');
    console.error('StashBase renderer startup failed.', cause);
    document.title = 'StashBase — Startup error';
    document.body.dataset.bootSettled = '1';
    root.render(<StartupFailure />);
  }
  return root;
}
