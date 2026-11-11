/**
 * NSH's own `Terminal` on the runtime's emulator (`RuntimeTerminals`, `deskfolk/native`), fed a
 * few colours and no program: what `--terminal nsh` draws in the app's palette, in either
 * appearance.
 */
import { colorScheme, View } from "nsh";
import { Terminal } from "nsh/base";
import { RuntimeTerminals } from "deskfolk/native";

export default function TerminalPalette() {
  return (
    <View class="flex-1">
      <RuntimeTerminals dark={colorScheme() === "dark"}>
        <Terminal
          testID="palette-terminal"
          ref={(r) => r.write("\x1b[31mred\x1b[0m\r\nplain\r\n\x1b[7minverse\x1b[0m")}
          class="flex-1 p-2"
        />
      </RuntimeTerminals>
    </View>
  );
}
