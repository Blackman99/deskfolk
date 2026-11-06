/**
 * What the map's 「加一个环节」 card offers (`settings/PlaybookAddMenu.svelte`, ADR 0105): the starter
 * templates that fit its round and a blank step. Choosing one hands back a draft — nothing is saved
 * until the panel's Save. A dropdown under the card; on a phone (720 wide or less), a sheet from the
 * bottom. Past the limit it only says so. Mount it while it is open.
 *
 * Props: `hook`; `anchor` (the card's ref: it hangs there and gets the focus back); `full`;
 * `onClose`; `onchoose(draft)`. Test ids: `playbook-add-menu`, `playbook-add-full`,
 * `playbook-template-<id>` (`blank` for the blank one).
 */
import { CUSTOM_STEPS_MAX, type CustomStep, type PlaybookHook } from "@real-bot/protocol";
import { Overlay, Text, View, windowSize, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { blankStep, templateStep, templatesFor, type CustomStepTemplateId } from "../../m/settings/custom-step-templates.ts";
import { rovingMenu } from "../sidebar/menu-roving";
import { BottomSheet, SheetItem, SheetSeparator } from "../BottomSheet";
import { Icon } from "../Icon";
import { shadow } from "../styles";

export function PlaybookAddMenu(props: {
  hook: PlaybookHook;
  anchor: ViewRef | null;
  /** The engine already holds as many steps of your own as it may. */
  full: boolean;
  onClose: () => void;
  onchoose: (step: CustomStep) => void;
}) {
  const c = () => copy().playbooks.own;
  const phone = () => windowSize().width <= 720;
  const roving = rovingMenu({ open: () => !phone() && !props.full, keys: () => [...templatesFor(props.hook), "blank"], onTab: () => close() });

  function choose(step: CustomStep): void {
    props.onClose();
    props.onchoose(step);
  }
  const chooseTemplate = (id: CustomStepTemplateId) => choose(templateStep(id, c().templates[id]!.name, c().rulesPrompt));
  const chooseBlank = () => choose(blankStep(props.hook, c().blankName));

  function close(): void {
    props.onClose();
    props.anchor?.focus();
  }

  const note = (testID: string, text: string) => (
    <Text testID={testID} class="px-[10px] py-1 text-[11px] leading-[1.45] text-ink-muted">{text}</Text>
  );

  return (
    <If
      when={phone()}
      else={
        <Overlay anchor={props.anchor} placement="bottom" align="start" offset={4} margin={8} onPressOutside={() => props.onClose()} onCancel={close}>
          <View
            role="menu"
            testID="playbook-add-menu"
            accessibilityLabel={c().addMenu}
            class="w-[280px] gap-[2px] p-[5px] bg-pane border border-line rounded-(--radius-md)"
            style={{ boxShadow: shadow("menu") }}
          >
            {props.full
              ? note("playbook-add-full", c().full(CUSTOM_STEPS_MAX))
              : [
                  note("playbook-add-title", c().templatesTitle),
                  ...templatesFor(props.hook).map((id) => (
                    <View
                      role="menuitem"
                      testID={`playbook-template-${id}`}
                      ref={roving.ref(id)}
                      accessibilityLabel={c().templates[id]!.name}
                      onFocus={() => roving.focused(id)}
                      onBlur={() => roving.blurred(id)}
                      onPress={() => chooseTemplate(id)}
                      class="items-start gap-[2px] px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle group"
                    >
                      <Text class="text-[13px] font-medium text-ink group-hover:text-brand">{c().templates[id]!.name}</Text>
                      <Text class="text-[11px] leading-[1.4] text-ink-muted">{c().templates[id]!.hint}</Text>
                    </View>
                  )),
                  <View role="none" class="h-px mx-2 my-[3px] bg-line-subtle" />,
                  <View
                    role="menuitem"
                    testID="playbook-template-blank"
                    ref={roving.ref("blank")}
                    accessibilityLabel={c().blank}
                    onFocus={() => roving.focused("blank")}
                    onBlur={() => roving.blurred("blank")}
                    onPress={chooseBlank}
                    class="px-[10px] py-[6px] rounded-(--radius-sm) hover:bg-line-subtle focus:bg-line-subtle group"
                  >
                    <View class="flex-row items-center gap-[6px]">
                      <Icon name="plus" size={12} class="tint-ink-muted group-hover:tint-brand" />
                      <Text class="text-[13px] font-medium text-ink group-hover:text-brand">{c().blank}</Text>
                    </View>
                  </View>,
                ]}
          </View>
        </Overlay>
      }
    >
      <BottomSheet title={c().addMenu} closeLabel={copy().common.close} onClose={props.onClose}>
        <View role="menu" testID="playbook-add-menu" accessibilityLabel={c().addMenu} class="px-2 pb-2">
          {props.full
            ? note("playbook-add-full", c().full(CUSTOM_STEPS_MAX))
            : [
                note("playbook-add-title", c().templatesTitle),
                ...templatesFor(props.hook).map((id) => (
                  <SheetItem role="menuitem" testID={`playbook-template-${id}`} label={c().templates[id]!.name} detail={c().templates[id]!.hint} onPress={() => chooseTemplate(id)} />
                )),
                <SheetSeparator />,
                <SheetItem role="menuitem" testID="playbook-template-blank" icon="plus" label={c().blank} onPress={chooseBlank} />,
              ]}
        </View>
      </BottomSheet>
    </If>
  );
}
