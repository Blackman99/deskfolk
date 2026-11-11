/** The red star after a required field's label (`RequiredStar.svelte`). */
import { Text } from "nsh";

export function RequiredStar() {
  return <Text class="font-bold text-danger" style={{ verticalAlign: "middle" }}>*</Text>;
}
