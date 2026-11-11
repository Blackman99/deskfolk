/** The UI kit renders, presses and reports (headless). */
import { mount, signal, Text, View } from "nsh";
import { expect, test } from "nsh/test";
import { Button } from "./Button";
import { iconUri } from "./Icon";
import { IconButton } from "./IconButton";
import { Switch } from "./Switch";

test("an icon is a template SVG with a stroke of 1.6 points at its size", () => {
  const uri = decodeURIComponent(iconUri("plus", 16).replace("data:image/svg+xml,", ""));
  expect(uri).toContain('viewBox="0 0 24 24"');
  expect(uri).toContain('stroke-width="2.400"');
  expect(decodeURIComponent(iconUri("plus", 24).replace("data:image/svg+xml,", ""))).toContain('stroke-width="1.600"');
});

test("filled icons draw solid", () => {
  const uri = decodeURIComponent(iconUri("pin", 16, true).replace("data:image/svg+xml,", ""));
  expect(uri).toContain('fill="#000"');
});
