import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { AGENT_ACCESS_MODES, type AgentAccessMode } from '@/features/agent/domain/access';
import { agentQuestions } from '@/features/agent/domain/question';
import { AgentPermissionMode } from '@/features/agent/ui/composer/permission-mode';

import { AgentActivityGroup, AgentPermissionCard } from './activity';
import { AgentQuestionCard } from './question-card';
import type { AgentToolBlock } from './tool-presentation';

const tools: AgentToolBlock[] = [
  {
    id: 'read-1',
    input: { arguments: { path: 'design-docs/design/agent-panel.md' } },
    kind: 'tool',
    name: 'stashbase_read_file',
    result: 'Loaded the Agent Panel experience contract.',
    status: 'done',
  },
  {
    id: 'search-1',
    input: { pattern: 'permission', path: 'renderer/src/features/agent' },
    kind: 'tool',
    name: 'Search',
    status: 'done',
  },
  {
    id: 'command-1',
    input: { command: 'pnpm test:agent' },
    kind: 'tool',
    name: 'Bash',
    result: 'Running Agent contract tests…',
    status: 'running',
  },
];

const permission: AgentToolBlock = {
  id: 'permission-tool',
  input: { command: 'pnpm test:agent', cwd: '/Library/Research' },
  kind: 'tool',
  name: 'Bash',
  permissionId: 'permission-1',
  permissionRequested: true,
  permissionTitle: null,
  approvalScopes: ['session'],
  status: 'awaiting',
};

const PLAN_BEFORE = [
  '# Screenshot tools',
  '',
  '## Decision',
  '',
  'Undecided. Compare Screely, Screenshot.rocks, and Pika first.',
  '',
  '## Open questions',
  '',
  '- Which one exports SVG?',
  '- Does the free plan watermark?',
].join('\n');

const PLAN_AFTER = [
  '# Screenshot tools',
  '',
  '## Decision',
  '',
  'Use Screely for lesson screenshots: browser frames, gradients, and PNG export on the free plan.',
  '',
  '## Open questions',
  '',
  '- Does the free plan watermark?',
  '',
  '## Next steps',
  '',
  '- Export the three lesson screenshots and compare them side by side.',
].join('\n');

const editPermission: AgentToolBlock = {
  id: 'edit-permission',
  input: {
    file_path: '/Library/Research/notes/screenshot-tools.md',
    new_string: PLAN_AFTER.split('\n').slice(2, 6).join('\n'),
    old_string: PLAN_BEFORE.split('\n').slice(2, 6).join('\n'),
  },
  kind: 'tool',
  name: 'Edit',
  permissionId: 'permission-2',
  permissionRequested: true,
  permissionTitle: null,
  status: 'awaiting',
};

const fileChangeTools: AgentToolBlock[] = [
  {
    id: 'read-plan',
    input: { file_path: '/Library/Research/notes/screenshot-tools.md' },
    kind: 'tool',
    name: 'Read',
    result: PLAN_BEFORE,
    status: 'done',
  },
  {
    id: 'diff-plan',
    input: {
      additions: 6,
      after: `${PLAN_AFTER}\n`,
      before: `${PLAN_BEFORE}\n`,
      deletions: 2,
      path: 'notes/screenshot-tools.md',
    },
    kind: 'tool',
    name: 'FileDiff',
    status: 'done',
  },
  {
    id: 'write-summary',
    input: {
      content: '# Lesson screenshots\n\nExported with Screely on 2026-09-09.\n',
      file_path: '/Library/Research/notes/lesson-screenshots.md',
    },
    kind: 'tool',
    name: 'Write',
    status: 'done',
  },
  {
    id: 'codex-change',
    input: {
      changes: [
        {
          diff: '@@ -1,3 +1,3 @@\n # Assets\n-- pending\n+- three lesson screenshots\n done\n',
          kind: { type: 'update' },
          path: 'assets/README.md',
        },
      ],
    },
    kind: 'tool',
    name: 'File change',
    status: 'done',
  },
];

function FileChangeHarness() {
  const [decision, setDecision] = useState<AgentToolBlock>(editPermission);
  return (
    <div className="w-[34rem] space-y-5">
      <AgentPermissionCard
        onReply={(_toolUseId, _permissionId, allow) => {
          setDecision((tool) => ({
            ...tool,
            permissionId: undefined,
            status: allow ? 'running' : 'denied',
          }));
          return true;
        }}
        tool={decision}
      />
      <AgentActivityGroup
        onOpenSource={() => undefined}
        sourceFor={(path) => {
          const folder = '/Library/Research';
          const relative = path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
          return relative.startsWith('/') ? null : { folderPath: folder, path: relative };
        }}
        steps={fileChangeTools}
      />
    </div>
  );
}

const questionAsk: AgentToolBlock = {
  id: 'question-tool',
  input: {
    questions: [
      {
        header: 'Publish?',
        multiSelect: false,
        options: [
          {
            description: 'Move the draft into the blog folder, commit, and push.',
            label: 'Publish now',
          },
          { description: 'Keep it in drafts until you have read it.', label: 'Hold the draft' },
        ],
        question: 'The post is written. Publish it to the site now?',
      },
      {
        header: 'Sections',
        multiSelect: true,
        options: [
          { description: 'A short lead-in.', label: 'Introduction' },
          { description: 'A closing summary.', label: 'Conclusion' },
          { description: 'Links and sources.', label: 'References' },
        ],
        question: 'Which sections should the post keep?',
      },
    ],
  },
  kind: 'tool',
  name: 'AskUserQuestion',
  permissionId: 'permission-3',
  permissionRequested: true,
  permissionTitle: null,
  status: 'awaiting',
};

// The card while the reader answers, and the same call settled below it.
function QuestionHarness() {
  const [decision, setDecision] = useState<AgentToolBlock>(questionAsk);
  return (
    <div className="w-[34rem] space-y-5">
      <AgentQuestionCard
        onReply={(_toolUseId, _permissionId, allow, reply) => {
          setDecision((tool) => ({
            ...tool,
            input: reply ? { ...tool.input, answers: reply.answers } : tool.input,
            permissionId: undefined,
            status: allow ? 'running' : 'denied',
          }));
          return true;
        }}
        questions={agentQuestions(questionAsk.name, questionAsk.input) ?? []}
        tool={decision}
      />
      <AgentActivityGroup
        steps={[
          {
            ...questionAsk,
            id: 'question-answered',
            input: {
              ...questionAsk.input,
              answers: {
                'The post is written. Publish it to the site now?': 'Hold the draft',
                'Which sections should the post keep?': 'Introduction, Conclusion',
              },
            },
            permissionId: undefined,
            status: 'done',
          },
        ]}
      />
    </div>
  );
}

function AgentActivityHarness({
  compact = false,
  computerUse = false,
  sessionCommands = false,
}: {
  compact?: boolean;
  computerUse?: boolean;
  sessionCommands?: boolean;
}) {
  const [mode, setMode] = useState<AgentAccessMode>('auto');
  const [decision, setDecision] = useState<AgentToolBlock>(
    computerUse
      ? {
          ...permission,
          name: 'Computer Use',
          permissionTitle: 'Allow Computer Use to use "Google Chrome"?',
          input: { app: 'com.google.Chrome' },
          approvalScopes: ['session', 'always'],
        }
      : {
          ...permission,
          ...(sessionCommands
            ? {
                permissionTitle: 'Allow Antigravity to run this command?',
                approvalScopes: ['session-commands'] as const,
              }
            : {}),
        },
  );
  return (
    <div className={compact ? 'w-[20rem] space-y-4' : 'w-[34rem] space-y-5'}>
      <AgentActivityGroup steps={tools} />
      <AgentPermissionCard
        onReply={(_toolUseId, _permissionId, allow) => {
          setDecision((tool) => ({
            ...tool,
            permissionId: undefined,
            status: allow ? 'running' : 'denied',
          }));
          return true;
        }}
        tool={decision}
      />
      <div className="flex justify-end">
        <AgentPermissionMode mode={mode} modes={AGENT_ACCESS_MODES} onChange={setMode} />
      </div>
    </div>
  );
}

const meta = {
  component: AgentActivityHarness,
  parameters: { controls: { disable: true }, fluidCanvas: { width: '38rem', minHeight: '30rem' } },
  title: 'Agent/Activity and permissions',
} satisfies Meta<typeof AgentActivityHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {};

export const AntigravityCommands: Story = {
  args: { sessionCommands: true },
};

export const FileChanges: Story = {
  render: () => <FileChangeHarness />,
};

export const Questions: Story = {
  render: () => <QuestionHarness />,
};

export const FailedAttemptThenSuccess: Story = {
  render: () => (
    <div className="w-[34rem] space-y-5">
      <p>I will update the transition in the plan.</p>
      <AgentActivityGroup
        steps={[
          {
            id: 'failed-edit',
            kind: 'tool',
            name: 'stashbase_edit_file',
            input: { path: '/project/ai-writing.md', old_text: 'Draft.', new_text: '' },
            status: 'error',
            result: 'EDIT_MISMATCH: old_text not found',
          },
          {
            id: 'successful-edit',
            kind: 'tool',
            name: 'stashbase_edit_file',
            input: { path: '/project/ai-writing.md', old_text: 'Draft。', new_text: 'Revised。' },
            status: 'done',
          },
        ]}
      />
      <p>The transition is now in the plan.</p>
    </div>
  ),
};

// The same work a moment later, when nothing is running between two calls.
const settledTools: AgentToolBlock[] = [];
for (const tool of tools) settledTools.push({ ...tool, status: 'done' });

export const StillWorking: Story = {
  render: () => (
    // Between two calls the turn is the only thing that says the work
    // continues: the live header names the step just taken, the settled one
    // below returns to the group at a glance.
    <div className="w-[34rem] space-y-5">
      <AgentActivityGroup live steps={settledTools} />
      <AgentActivityGroup steps={settledTools} />
    </div>
  ),
};

export const Compact: Story = {
  args: { compact: true },
  parameters: { fluidCanvas: { width: '22rem', minHeight: '30rem' } },
};

export const ComputerUseApproval: Story = {
  args: { computerUse: true },
};

export const CompactComputerUseApproval: Story = {
  args: { computerUse: true, compact: true },
  parameters: { fluidCanvas: { width: '22rem', minHeight: '30rem' } },
};
