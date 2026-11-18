/**
 * The views whose code loads the first time one is shown (`lazy-view.tsx`), under the names of the
 * views they stand for: an importer takes the view from here and its types, `import type` only,
 * from the view's own module. Each draws with a part of `nsh/base` that the phone's page would
 * otherwise download before its first screen:
 *
 * - `ComposerEditor`: `RichEditor` (the largest, with what it shares with `TextView`);
 * - `MarkdownBody`: `TextView`;
 * - `ArtifactCodeEditor`: the code `Editor`;
 * - `NshTerminal`, `TerminalPane`, `PdfPane`: `Terminal` (and the development panes' PDF);
 * - `SheetView`: `DataTable`; `WordView`: `TextView`;
 * - `ArtifactTree`: `Tree`;
 * - `NotificationQuietHours`, `SpendHeader`: the date and time pickers;
 * - `PdfViewer`, `OfficeViewer`, `MarkdownAnnotator`, `RemoteScreenView`, `TerminalPane`, `PdfPane`:
 *   the app's own Rust (`deskfolk/native`: PDF pages, Office files, Markdown blocks, the remote
 *   screen), which is a side module of its own once nothing the app loads at start imports it.
 *
 * A static import of one of those modules from anything the app loads at start brings its part
 * back before the first screen; `scripts/phone-package.test.ts` checks the package for it.
 * `Select`, `MultiSelect`, menus and popovers stay: small, and on most screens. The composer and
 * a message's text are fetched once the shell is up (`preload`); the others when first shown.
 */
import { lazyView } from "./lazy-view";
import type { ComposerEditor as ComposerEditorView } from "./chat/ComposerEditor";
import type { MarkdownBody as MarkdownBodyView } from "./MarkdownBody";
import type { ArtifactCodeEditor as ArtifactCodeEditorView } from "./overlays/ArtifactCodeEditor";
import type { ArtifactTree as ArtifactTreeView } from "./overlays/ArtifactTree";
import type { SheetView as SheetViewView } from "./overlays/office-sheet";
import type { WordView as WordViewView } from "./overlays/office-document";
import type { NotificationQuietHours as NotificationQuietHoursView } from "./settings/notification-quiet-hours";
import type { SpendHeader as SpendHeaderView } from "./spend/SpendHeader";
import type { NshTerminal as NshTerminalView } from "../NshTerminal";
import type { PdfPane as PdfPaneView, TerminalPane as TerminalPaneView } from "../Tools";
import type { PdfViewer as PdfViewerView } from "./overlays/PdfViewer";
import type { OfficeViewer as OfficeViewerView } from "./overlays/OfficeViewer";
import type { MarkdownAnnotator as MarkdownAnnotatorView } from "./annotations/MarkdownAnnotator";
import type { RemoteScreenView as RemoteScreenViewView } from "./overlays/RemoteScreenView";

type PropsOf<V> = V extends (props: infer P) => unknown ? P : never;

export const ComposerEditor = lazyView<PropsOf<typeof ComposerEditorView>>(() => import("./chat/ComposerEditor").then((m) => m.ComposerEditor), { preload: true });
export const MarkdownBody = lazyView<PropsOf<typeof MarkdownBodyView>>(() => import("./MarkdownBody").then((m) => m.MarkdownBody), { preload: true });
export const ArtifactCodeEditor = lazyView<PropsOf<typeof ArtifactCodeEditorView>>(() => import("./overlays/ArtifactCodeEditor").then((m) => m.ArtifactCodeEditor));
export const ArtifactTree = lazyView<PropsOf<typeof ArtifactTreeView>>(() => import("./overlays/ArtifactTree").then((m) => m.ArtifactTree));
export const SheetView = lazyView<PropsOf<typeof SheetViewView>>(() => import("./overlays/office-sheet").then((m) => m.SheetView));
export const WordView = lazyView<PropsOf<typeof WordViewView>>(() => import("./overlays/office-document").then((m) => m.WordView));
export const NotificationQuietHours = lazyView<PropsOf<typeof NotificationQuietHoursView>>(() => import("./settings/notification-quiet-hours").then((m) => m.NotificationQuietHours));
export const SpendHeader = lazyView<PropsOf<typeof SpendHeaderView>>(() => import("./spend/SpendHeader").then((m) => m.SpendHeader));
export const NshTerminal = lazyView<PropsOf<typeof NshTerminalView>>(() => import("../NshTerminal").then((m) => m.NshTerminal));
export const TerminalPane = lazyView<PropsOf<typeof TerminalPaneView>>(() => import("../Tools").then((m) => m.TerminalPane));
export const PdfPane = lazyView<PropsOf<typeof PdfPaneView>>(() => import("../Tools").then((m) => m.PdfPane));
export const PdfViewer = lazyView<PropsOf<typeof PdfViewerView>>(() => import("./overlays/PdfViewer").then((m) => m.PdfViewer));
export const OfficeViewer = lazyView<PropsOf<typeof OfficeViewerView>>(() => import("./overlays/OfficeViewer").then((m) => m.OfficeViewer));
export const MarkdownAnnotator = lazyView<PropsOf<typeof MarkdownAnnotatorView>>(() => import("./annotations/MarkdownAnnotator").then((m) => m.MarkdownAnnotator));
export const RemoteScreenView = lazyView<PropsOf<typeof RemoteScreenViewView>>(() => import("./overlays/RemoteScreenView").then((m) => m.RemoteScreenView));
