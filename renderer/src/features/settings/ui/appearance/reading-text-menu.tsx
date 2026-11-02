/** The document's reading panel, offered on the page the way an e-reader
 *  offers its type panel: one segmented row for the reading font, each preset
 *  set in its own face, and one for the reading text size. Both are the
 *  app-wide Appearance preferences, edited through the same optimistic write
 *  and the same segmented picker as their Settings rows, so the two can never
 *  disagree. The panel stays open while the reader tries presets; a refused
 *  save rolls the choice back and names the failure inside it. The trigger is a
 *  glyph alone, named by its tooltip, so the bar stays quiet over the page. */
import { Popover } from '@base-ui/react/popover';

import { Button } from '@/components/ui/button';
import { Elevated } from '@/components/ui/elevated';
import { Tooltip } from '@/components/ui/tooltip';
import type { AppearancePort } from '@/features/settings/application/ports';
import {
  isReadingFont,
  PRESET_ROWS,
  presetChange,
  READING_FONT_CHOICES,
  readingFontChange,
  SCALE_CHOICES,
} from '@/features/settings/domain/appearance';
import { useAppearance } from '@/features/settings/hooks/use-appearance';
import { PresetChoice } from '@/features/settings/ui/appearance/preset-choice';
import { useShape } from '@/lib/shape-context';
import { SizeProvider } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { FailureNotice } from '@/shared/ui/failure-notice';

/** "Aa" set in the face the document is read in, the way the panel sets each
 *  preset in its own face, so the glyph itself shows the current choice.
 *  Faces differ in cap height, so it is sized by its capitals: they stand as
 *  tall as the neighbouring icon in Serif, Sans, or an installed writing font
 *  alike. */
function ReadingTextGlyph() {
  return (
    <span
      aria-hidden
      className="block leading-none [text-box:trim-both_cap_alphabetic]"
      style={{
        fontFamily: 'var(--writing-font, var(--font-reading))',
        fontSize: 14,
        fontSizeAdjust: 'cap-height 0.72',
      }}
    >
      Aa
    </span>
  );
}

export function ReadingTextMenu({ appearanceApi }: { appearanceApi: AppearancePort }) {
  const appearance = useAppearance(appearanceApi);
  const shape = useShape();
  const preferences = appearance.preferences;
  // An installed writing font, chosen in Settings, stands in for either preset.
  const installed = preferences?.writingFont ?? null;
  const font =
    installed ??
    READING_FONT_CHOICES.find((choice) => choice.value === preferences?.readingFont)?.label;
  const readingTextName = font ? `Reading text: ${font}` : 'Reading text';
  return (
    <Popover.Root>
      <Tooltip content={readingTextName} side="bottom">
        <Popover.Trigger
          render={
            <Button
              aria-label={readingTextName}
              disabled={preferences === null}
              size="icon-compact"
              variant="ghost"
            >
              <ReadingTextGlyph />
            </Button>
          }
        />
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          className="z-50 outline-none"
          side="bottom"
          sideOffset={6}
        >
          <Popover.Popup
            aria-label="Reading text"
            className={cn('flex flex-col gap-3 p-3 outline-none', shape.container)}
            render={<Elevated offset={2} shadowLevel={3} />}
          >
            <SizeProvider size="compact">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
                <span className="text-caption text-muted-foreground">Font</span>
                <PresetChoice
                  fill
                  choices={READING_FONT_CHOICES}
                  label="Font"
                  onChoose={(value) => {
                    if (isReadingFont(value)) appearance.change(readingFontChange(value));
                  }}
                  value={installed ? null : (preferences?.readingFont ?? null)}
                />
                <span className="text-caption text-muted-foreground">Size</span>
                <PresetChoice
                  fill
                  choices={SCALE_CHOICES}
                  label="Size"
                  onChoose={(value) => {
                    const change = presetChange(PRESET_ROWS.readingTextSize, value);
                    if (change) appearance.change(change);
                  }}
                  value={preferences?.readingTextSize ?? null}
                />
              </div>
            </SizeProvider>
            {appearance.failure && (
              <FailureNotice className="max-w-64 text-caption" failure={appearance.failure} />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
