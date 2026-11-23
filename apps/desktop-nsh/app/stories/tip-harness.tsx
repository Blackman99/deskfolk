/** Standalone mount entry for `src/ui/tip.test.tsx` (headless layout & interaction checks without a daemon). */
import "../src/platform/install";
import { mount } from "nsh";
import TipStory from "./tip";

mount(TipStory);
