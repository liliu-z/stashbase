/**
 * The open project's math mode, shared by the surfaces that render it: a
 * document's editor and the Chat transcript. Each one reads the same value, so
 * one switch changes both at once. Application composition owns the state and
 * mounts `MathModeProvider`; features only read it, which keeps Documents and
 * Agent from importing each other.
 */
import { createContext, useContext } from 'react';

import type { FailureView } from '@/shared/domain/feature-error';

export interface MathModeState {
  /** Whether `$...$` opens a formula. Off until the project's record has been
   *  read, so a reopening window shows plain dollars for one frame rather than
   *  flashing formulas into place. */
  enabled: boolean;
  /** The project the state belongs to, or null with no folder open. The switch
   *  has nothing to write without one. */
  scope: string | null;
  /** The server's sentence about a refused write, or null while the switch is
   *  answering. The switch rolls back and names it; the choice never stays
   *  painted on screen when nothing stored it. */
  failure: FailureView | null;
  /** Stores the choice for the current project. Safe to call with no folder:
   *  it does nothing, since there is no project to keep the choice for. */
  setEnabled: (enabled: boolean) => void;
}

const DEFAULT_MATH_MODE: MathModeState = {
  enabled: false,
  failure: null,
  scope: null,
  setEnabled: () => {},
};

const MathModeContext = createContext<MathModeState>(DEFAULT_MATH_MODE);

export const MathModeProvider = MathModeContext.Provider;

export function useMathMode(): MathModeState {
  return useContext(MathModeContext);
}

/** The switch's tooltip, and the same sentence the guide gives writers. */
export const MATH_MODE_TOOLTIP =
  'Math mode for this project. Use $...$ for formulas and \\$ for a literal dollar sign.';

/** Names the switch for screen readers, matching the label `Math`. */
export const MATH_MODE_LABEL = 'Math';
