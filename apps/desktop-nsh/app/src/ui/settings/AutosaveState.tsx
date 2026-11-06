/**
 * What a settings page that saves as you type says about it (`settings/AutosaveState.svelte`):
 * saving, failed, saved, or the hint before the first change. The page's own state, passed in.
 *
 * Props: `saving`; `failed` (the last save did not land: shown in the danger colour); `saved`
 * (at least one save has landed since the page opened). Weight: saving, then failed, then saved,
 * then the hint.
 */
import { Text } from "nsh";
import { copy } from "../../runtime";

export function AutosaveState(props: { saving: boolean; failed: boolean; saved: boolean }) {
  const words = () => {
    const t = copy();
    if (props.saving) return t.sidebar.autoSaving;
    if (props.failed) return t.settings.saveFailed;
    if (props.saved) return t.sidebar.autoSaved;
    return t.sidebar.autoSaveHint;
  };
  return (
    <Text
      testID="settings-save-state"
     
      class={`text-[12px] font-medium line-clamp-1 ${props.failed && !props.saving ? "text-danger-text" : "text-ink-muted"}`}
    >
      {words()}
    </Text>
  );
}
