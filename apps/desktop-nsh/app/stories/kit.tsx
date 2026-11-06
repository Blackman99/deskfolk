/** The UI kit on one screen. */
import { Text, View } from "nsh";
import { Button } from "../src/ui/Button";
import { Icon } from "../src/ui/Icon";
import { IconButton } from "../src/ui/IconButton";

export default function Kit() {
  return (
    <View class="flex-1 gap-4 p-6 bg-bg">
      <View class="flex-row gap-2 items-center">
        <Button variant="primary" icon="plus" testID="primary">新建</Button>
        <Button variant="secondary">取消</Button>
        <Button variant="ghost">稍后</Button>
        <Button variant="danger">删除</Button>
        <Button variant="danger-soft" size="sm">移除</Button>
      </View>
      <View class="flex-row gap-2 items-center">
        <IconButton icon="settings" label="设置" />
        <IconButton icon="pin" label="置顶" pressed filled />
        <Icon name="check" size={20} class="tint-ok" />
        <Text class="text-[13px] text-ink-muted">kit</Text>
      </View>
    </View>
  );
}
