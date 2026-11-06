/** Document presentation and writing aids share the saved appearance record. */
import { Switch } from '@/components/ui/switch';
import type { AppearancePort, SystemTextPort } from '@/features/settings/application/ports';
import {
  appearanceChange,
  EDITOR_TOGGLES,
  INCLUDED_CODE_FONTS,
  PRESET_ROWS,
  READING_TEXT_SIZE_DETAIL,
  spellcheckLanguageLabel,
} from '@/features/settings/domain/appearance';
import { useAppearance } from '@/features/settings/hooks/use-appearance';
import { useSystemText } from '@/features/settings/hooks/use-system-text';
import {
  SettingsGroup,
  SettingsList,
  SettingsPane,
  SettingsRow,
} from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

import { ChoiceSelect } from './choice-select';
import { DocumentFontPicker } from './document-font-picker';
import { FontPicker } from './font-picker';
import { PresetRowView } from './preset-row-view';
import { ReadingSizeSlider } from './reading-size-slider';

const SYSTEM_LANGUAGE = '';
export function EditorPanel({
  appearanceApi,
  systemTextApi,
}: {
  appearanceApi: AppearancePort;
  systemTextApi?: SystemTextPort | undefined;
}) {
  const appearance = useAppearance(appearanceApi);
  const system = useSystemText(systemTextApi);
  const preferences = appearance.preferences;
  const loading = preferences === null;
  const languages = [
    { label: 'System default', value: SYSTEM_LANGUAGE },
    ...system.spellcheckLanguages.map((code) => ({
      label: spellcheckLanguageLabel(code),
      value: code,
    })),
  ];
  return (
    <SettingsPane title="Editor">
      <SettingsGroup
        title="Documents"
        hint={appearance.failure ? <FailureNotice failure={appearance.failure} /> : undefined}
      >
        <SettingsList>
          <SettingsRow
            detail="The typeface for your documents."
            title="Font"
            trail={<DocumentFontPicker appearance={appearance} system={system} />}
          />
          <SettingsRow
            detail="The typeface for code blocks and inline code."
            title="Code font"
            trail={
              <FontPicker
                disabled={loading}
                included={INCLUDED_CODE_FONTS}
                includedValue={INCLUDED_CODE_FONTS[0]?.value ?? null}
                installed={system.fonts}
                installedFailure={system.fontsFailure?.message ?? null}
                label="Code font"
                monospaceOnly
                onChooseIncluded={() => appearance.change(appearanceChange('codeFont', null))}
                onChooseInstalled={(family) =>
                  appearance.change(appearanceChange('codeFont', family))
                }
                value={preferences?.codeFont ?? null}
              />
            }
          />
          <SettingsRow
            detail={READING_TEXT_SIZE_DETAIL}
            title="Text size"
            trail={<ReadingSizeSlider appearance={appearance} className="w-56" />}
          />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.lineSpacing} />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.lineWidth} />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.pageTexture} />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title="Writing">
        <SettingsList>
          {EDITOR_TOGGLES.map((toggle) => (
            <SettingsRow
              detail={toggle.detail}
              key={toggle.field}
              title={toggle.title}
              trail={
                <Switch
                  checked={preferences?.[toggle.field] ?? false}
                  disabled={loading}
                  label={toggle.title}
                  labelHidden
                  onToggle={() => {
                    if (preferences) {
                      appearance.change(appearanceChange(toggle.field, !preferences[toggle.field]));
                    }
                  }}
                />
              }
            />
          ))}
          {languages.length > 1 && (
            <SettingsRow
              detail="The dictionary spelling is checked against."
              title="Spelling language"
              trail={
                <ChoiceSelect
                  choices={languages}
                  disabled={loading || !preferences?.spellcheck}
                  label="Spelling language"
                  onChoose={(value) =>
                    appearance.change(
                      appearanceChange(
                        'spellcheckLanguage',
                        value === SYSTEM_LANGUAGE ? null : value,
                      ),
                    )
                  }
                  value={preferences?.spellcheckLanguage ?? SYSTEM_LANGUAGE}
                />
              }
            />
          )}
        </SettingsList>
      </SettingsGroup>
    </SettingsPane>
  );
}
