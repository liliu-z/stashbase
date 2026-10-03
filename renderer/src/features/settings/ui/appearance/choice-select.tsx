import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type SelectOption,
} from '@/components/ui/select';

export interface ChoiceSelectProps {
  readonly choices: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string | null;
  onChoose(value: string): void;
}

/** A Settings row's list choice: a compact trigger naming the current value
 *  and a popup of the rest, for lists too long for a segmented control. */
export function ChoiceSelect({
  choices,
  disabled = false,
  label,
  onChoose,
  value,
}: ChoiceSelectProps) {
  return (
    <Select
      disabled={disabled}
      items={choices}
      onValueChange={onChoose}
      size="compact"
      value={value ?? ''}
    >
      <SelectTrigger aria-label={label} className="w-56" />
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
