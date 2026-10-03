/**
 * General › Appearance: four groups (Theme, Interface, Writing, Editor) over
 * one saved record. Each row changes one field, applies it to this window at
 * once, and saves it; the fonts and spellcheck languages come from this
 * computer where the desktop app can list them.
 */
import { Switch } from '@/components/ui/switch';
import type { AppearancePort, SystemTextPort } from '@/features/settings/application/ports';
import {
  appearanceChange,
  DARK_THEME_CHOICES,
  EDITOR_TOGGLES,
  INCLUDED_CODE_FONTS,
  isDarkTheme,
  isLightTheme,
  isReadingFont,
  LIGHT_THEME_CHOICES,
  PRESET_ROWS,
  presetChange,
  READING_FONT_CHOICES,
  readingFontChange,
  spellcheckLanguageLabel,
  type PresetRow,
} from '@/features/settings/domain/appearance';
import { useAppearance, type AppearanceViewModel } from '@/features/settings/hooks/use-appearance';
import { useSystemText } from '@/features/settings/hooks/use-system-text';
import { ChoiceSelect } from '@/features/settings/ui/appearance/choice-select';
import { FontPicker } from '@/features/settings/ui/appearance/font-picker';
import { PresetChoice } from '@/features/settings/ui/appearance/preset-choice';
import { SettingsGroup, SettingsList, SettingsRow } from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

export interface AppearancePanelProps {
  appearanceApi: AppearancePort;
  /** Absent outside the desktop app, where only the bundled fonts are listed. */
  systemTextApi?: SystemTextPort | undefined;
}

/** The value `''` stands for "follow the system" in the language list. */
const SYSTEM_LANGUAGE = '';

function PresetRowView({ appearance, row }: { appearance: AppearanceViewModel; row: PresetRow }) {
  const preferences = appearance.preferences;
  return (
    <SettingsRow
      detail={row.detail}
      title={row.title}
      trail={
        <PresetChoice
          choices={row.choices}
          disabled={preferences === null}
          label={row.title}
          onChoose={(value) => {
            const change = presetChange(row, value);
            if (change) appearance.change(change);
          }}
          value={preferences ? preferences[row.field] : null}
        />
      }
    />
  );
}

export function AppearancePanel({ appearanceApi, systemTextApi }: AppearancePanelProps) {
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
    <>
      <SettingsGroup
        hint={appearance.failure ? <FailureNotice failure={appearance.failure} /> : undefined}
        title="Theme"
      >
        <SettingsList>
          <PresetRowView appearance={appearance} row={PRESET_ROWS.theme} />
          <SettingsRow
            detail="Used in light mode."
            title="Light theme"
            trail={
              <ChoiceSelect
                choices={LIGHT_THEME_CHOICES}
                disabled={loading}
                label="Light theme"
                onChoose={(value) => {
                  if (isLightTheme(value)) appearance.change(appearanceChange('lightTheme', value));
                }}
                value={preferences?.lightTheme ?? null}
              />
            }
          />
          <SettingsRow
            detail="Used in dark mode."
            title="Dark theme"
            trail={
              <ChoiceSelect
                choices={DARK_THEME_CHOICES}
                disabled={loading}
                label="Dark theme"
                onChoose={(value) => {
                  if (isDarkTheme(value)) appearance.change(appearanceChange('darkTheme', value));
                }}
                value={preferences?.darkTheme ?? null}
              />
            }
          />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title="Interface">
        <SettingsList>
          <PresetRowView appearance={appearance} row={PRESET_ROWS.uiScale} />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.reduceMotion} />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title="Writing">
        <SettingsList>
          <SettingsRow
            detail="Serif suits prose; Sans suits documents full of code. Or use any font on this computer."
            title="Font"
            trail={
              <FontPicker
                disabled={loading}
                included={READING_FONT_CHOICES}
                includedValue={preferences?.readingFont ?? null}
                installed={system.fonts}
                installedFailure={system.fontsFailure?.message ?? null}
                label="Writing font"
                onChooseIncluded={(value) => {
                  if (isReadingFont(value)) appearance.change(readingFontChange(value));
                }}
                onChooseInstalled={(family) =>
                  appearance.change(appearanceChange('writingFont', family))
                }
                value={preferences?.writingFont ?? null}
              />
            }
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
          <PresetRowView appearance={appearance} row={PRESET_ROWS.readingTextSize} />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.lineSpacing} />
          <PresetRowView appearance={appearance} row={PRESET_ROWS.lineWidth} />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title="Editor">
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
    </>
  );
}
