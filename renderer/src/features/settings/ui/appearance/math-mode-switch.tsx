/** The project's Math switch, offered beside the reading controls on the page:
 *  one labelled switch that says whether `$...$` opens a formula in this
 *  project's documents and its Chat. It reads and writes the application
 *  composition's shared state rather than a port of its own, so the two
 *  surfaces that render formulas always agree. A refused save rolls the switch
 *  back and names the failure under it. */
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { FailureNotice } from '@/shared/ui/failure-notice';
import { MATH_MODE_LABEL, MATH_MODE_TOOLTIP, useMathMode } from '@/shared/ui/math-mode';

export function MathModeSwitch() {
  const mathMode = useMathMode();
  return (
    <span className="relative flex flex-col items-start">
      <Tooltip content={MATH_MODE_TOOLTIP} side="bottom">
        <Switch
          checked={mathMode.enabled}
          disabled={mathMode.scope === null}
          label={MATH_MODE_LABEL}
          onToggle={() => mathMode.setEnabled(!mathMode.enabled)}
          size="compact"
        />
      </Tooltip>
      {mathMode.failure && (
        <FailureNotice className="absolute top-full left-0 max-w-56" failure={mathMode.failure} />
      )}
    </span>
  );
}
