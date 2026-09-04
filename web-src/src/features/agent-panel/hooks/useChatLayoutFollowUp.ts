/**
 * Chat layout follow-up on folder and viewport changes — one concern in two
 * interlocked effects. A folder switch activates (or opens) the right welcome
 * chat tab, and a viewport/document change may auto-collapse the chat column
 * and later restore it. The two share the private refs below: a folder switch
 * resets the responsive-collapse bookkeeping so the new folder starts from
 * the user's explicit chat-visibility choice.
 */
import { useEffect, useRef } from 'react';
import { readPreferredAgent } from '@/common/lib/agentPreference';
import {
  shouldOpenInitialChatOnWindowEntry,
  switchWelcomeTabPlan,
} from '@/features/agent-panel/lib/folderState';
import { blankTabToReuse } from '@/store/lib/chatTabPlan';
import { makeChatTab, type Action, type ChatSlice, type WorkspaceSlice } from '@/store/state/state';
import { shouldAutoCollapseChat } from '@/common/lib/workspaceLayout';

export function useChatLayoutFollowUp(
  state: Pick<WorkspaceSlice, 'booted' | 'folderPath'>
    & Pick<ChatSlice, 'activeChatTabId' | 'chatOpen' | 'chatTabs'>,
  layout: { hasDocument: boolean; compact: boolean },
  dispatch: (action: Action) => void,
) {
  const { hasDocument, compact } = layout;
  const defaultChatFolderRef = useRef<string | null>(null);
  const responsiveChatCollapsedRef = useRef(false);
  const previousWorkspaceRef = useRef({
    folderPath: '',
    hasDocument: false,
    compact,
  });

  useEffect(() => {
    if (!state.folderPath) {
      if (!state.booted || defaultChatFolderRef.current === '') return;
      const shouldOpen = shouldOpenInitialChatOnWindowEntry(
        state.booted,
        '',
        state.chatTabs.length,
        defaultChatFolderRef.current,
      );
      defaultChatFolderRef.current = '';
      if (shouldOpen) {
        // A bare window's boot opens its one chat; the Gallery band
        // under the composer needs no flag here — every contentless
        // chat in a bare window derives it from window state.
        dispatch({
          type: 'CHAT_AGENT_OPEN',
          agent: readPreferredAgent(),
          tab: makeChatTab(readPreferredAgent(), state.chatTabs),
        });
      } else {
        // The window just went bare with chats still open (folder removal /
        // library retirement). Land back on a completely blank tab — bare,
        // it derives the Gallery band, and the sidebar keeps its Choose
        // Folder row, so the window keeps a visible way into a folder.
        // Started chats are user work and are never re-purposed.
        const blankId = blankTabToReuse(state.chatTabs, readPreferredAgent());
        if (blankId && state.activeChatTabId !== blankId) {
          dispatch({ type: 'CHAT_TAB_ACTIVATE', id: blankId });
        }
      }
      return;
    }
    if (defaultChatFolderRef.current === state.folderPath) return;
    defaultChatFolderRef.current = state.folderPath;
    const agent = readPreferredAgent();
    // No Gallery bookkeeping on folder bind: the bare-window band is
    // derived from window state and stops by itself the moment the
    // folder is set; the summoned form is an app-level overlay that
    // never touches chat tabs.
    // Chat tabs (and their scope-bound sessions) survive folder switches. A
    // switch with existing chats activates a welcome tab for the new
    // folder without touching panel visibility — reusing a completely
    // blank tab when one exists (it follows the window default on its
    // next connect), else creating a fresh tab. Started chats, drafts,
    // and attachments are never rebound by this.
    if (state.chatTabs.length === 0) {
      if (shouldOpenInitialChatOnWindowEntry(state.booted, state.folderPath, 0, null)) {
        dispatch({
          type: 'CHAT_AGENT_OPEN',
          agent,
          tab: makeChatTab(agent, state.chatTabs),
        });
      }
      return;
    }
    const plan = switchWelcomeTabPlan(state.chatTabs, state.activeChatTabId, state.folderPath, agent);
    if (plan.kind === 'activate') {
      if (state.activeChatTabId !== plan.id) dispatch({ type: 'CHAT_TAB_ACTIVATE', id: plan.id });
    } else if (plan.kind === 'new') {
      dispatch({ type: 'CHAT_TAB_NEW', tab: makeChatTab(agent, state.chatTabs) });
    }
    // plan.kind === 'none': the active chat is already bound to the new
    // folder (create_project auto-select) — it IS the working entry.
  }, [dispatch, state.activeChatTabId, state.booted, state.chatTabs, state.folderPath]);

  useEffect(() => {
    const previous = previousWorkspaceRef.current;
    const folderChanged = previous.folderPath !== state.folderPath;
    previousWorkspaceRef.current = {
      folderPath: state.folderPath,
      hasDocument,
      compact,
    };

    if (folderChanged) {
      responsiveChatCollapsedRef.current = false;
      return;
    }
    if (shouldAutoCollapseChat({
      chatOpen: state.chatOpen,
      hasDocument,
      compact,
      previousHasDocument: previous.hasDocument,
      previousCompact: previous.compact,
    })) {
      responsiveChatCollapsedRef.current = true;
      dispatch({ type: 'CHAT_TOGGLE' });
      return;
    }
    if (responsiveChatCollapsedRef.current && state.chatOpen) {
      // The user explicitly reopened Chat while the document is still
      // active, so future document changes must not fight that choice.
      responsiveChatCollapsedRef.current = false;
      return;
    }
    if (
      responsiveChatCollapsedRef.current
      && !state.chatOpen
      && (!hasDocument || !compact)
    ) {
      responsiveChatCollapsedRef.current = false;
      dispatch({ type: 'CHAT_TOGGLE' });
    }
  }, [compact, dispatch, hasDocument, state.chatOpen, state.folderPath]);
}
