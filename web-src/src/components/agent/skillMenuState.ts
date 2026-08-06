import type { AgentSkill } from './types';

export function skillMenuState({ loading, skills, error }: { loading: boolean; skills: AgentSkill[]; error: string | null }): {
  kind: 'loading' | 'error' | 'empty' | 'ready';
  message?: string;
} {
  if (loading) return { kind: 'loading', message: 'Finding skills for this folder…' };
  if (error) return { kind: 'error', message: error };
  if (!skills.length) return { kind: 'empty', message: 'No skills are available for this folder.' };
  return { kind: 'ready' };
}

export function reconciledSkillSelection(selected: AgentSkill | null, skills: AgentSkill[]): AgentSkill | null {
  return selected && skills.some((skill) => skill.id === selected.id) ? selected : null;
}
