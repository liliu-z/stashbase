/**
 * The icons a persona may wear, in the order the editor offers them.
 *
 * The renderer's own vocabulary: each feature's infrastructure maps the wire
 * icon onto it, and the compiler holds the two lists to the same names there.
 */
export const PERSONA_ICON_NAMES = [
  'drama',
  'hammer',
  'megaphone',
  'newspaper',
  'book-open',
  'pen-line',
  'feather',
  'graduation-cap',
  'briefcase',
  'lightbulb',
  'mic',
  'heart',
  'scale',
  'code',
  'compass',
  'flask-conical',
  'message-circle',
  'smile',
] as const;

export type PersonaIconName = (typeof PERSONA_ICON_NAMES)[number];

export const DEFAULT_PERSONA_ICON: PersonaIconName = 'drama';
