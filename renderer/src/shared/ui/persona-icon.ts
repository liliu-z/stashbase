import {
  BookOpen,
  Briefcase,
  Code,
  Compass,
  Drama,
  Feather,
  FlaskConical,
  GraduationCap,
  Hammer,
  Heart,
  Lightbulb,
  Megaphone,
  MessageCircle,
  Mic,
  Newspaper,
  PenLine,
  Scale,
  Smile,
} from 'lucide-react';

import type { IconComponent } from '@/lib/icon-context';
import type { PersonaIconName } from '@/shared/domain/persona-icon';

/** The glyph each persona icon name wears. One table for the composer's
 *  picker and the Gallery's shelf, so a persona looks the same in both. */
export const PERSONA_ICONS: Record<PersonaIconName, IconComponent> = {
  drama: Drama,
  hammer: Hammer,
  megaphone: Megaphone,
  newspaper: Newspaper,
  'book-open': BookOpen,
  'pen-line': PenLine,
  feather: Feather,
  'graduation-cap': GraduationCap,
  briefcase: Briefcase,
  lightbulb: Lightbulb,
  mic: Mic,
  heart: Heart,
  scale: Scale,
  code: Code,
  compass: Compass,
  'flask-conical': FlaskConical,
  'message-circle': MessageCircle,
  smile: Smile,
};

export function personaIcon(name: PersonaIconName | null | undefined): IconComponent {
  return (name && PERSONA_ICONS[name]) || Drama;
}
