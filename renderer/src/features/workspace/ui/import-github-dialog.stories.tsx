import type { Meta, StoryObj } from '@storybook/react-vite';

import type { GitHubImportView } from '@/features/workspace/hooks/use-project-entry';

import { ImportGitHubDialog } from './import-github-dialog';

const view = (overrides: Partial<GitHubImportView>): GitHubImportView => ({
  canSubmit: true,
  checkingOutcome: false,
  existingPath: null,
  failure: null,
  folderName: 'LinkedIn Ghostwriter',
  inputLocked: false,
  location: '/Users/me/Documents/StashBase',
  nameIssue: null,
  pending: false,
  retainedPath: null,
  source: null,
  url: '',
  urlIssue: null,
  cancel: () => undefined,
  chooseLocation: () => undefined,
  openExisting: () => undefined,
  setFolderName: () => undefined,
  setUrl: () => undefined,
  startAnotherCopy: () => undefined,
  submit: () => undefined,
  ...overrides,
});

const meta = {
  title: 'Workspace/Copy dialog',
  component: ImportGitHubDialog,
  parameters: { controls: { disable: true }, fluidCanvas: { width: '34rem', minHeight: '24rem' } },
} satisfies Meta<typeof ImportGitHubDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A Gallery entry's copy: its repository is fixed, so only the folder name
 *  and where it goes are asked, and nothing downloads until confirmed. */
export const GalleryCopy: Story = {
  args: {
    import: view({ source: 'LinkedIn Ghostwriter', url: 'https://github.com/owner/repo' }),
    onClose: () => undefined,
    open: true,
  },
};

/** The same acquisition from a pasted URL, with the same location row. */
export const FromGitHub: Story = {
  args: {
    import: view({ folderName: 'repo', url: 'https://github.com/owner/repo' }),
    onClose: () => undefined,
    open: true,
  },
};
