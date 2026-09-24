/**
 * pdf.js 的懒加载入口和一层薄适配。`pdfjs-dist` 和它的 worker 只在第一次打开 PDF 时才取（动态
 * import；worker 由 Vite 打成本地文件，不走 CDN）。用的是 legacy 构建：modern 构建直接调用
 * `Math.sumPrecise`、`Map#getOrInsertComputed` 这类很新的 API，桌面端最低 macOS 13 的 WebKit 没有，
 * legacy 构建带了 polyfill。CMap 和 Symbol / Dingbats 两个标准字体由
 * vite.config.ts 的 `pdfjsData()` 做成按文件懒加载的 JS 模块，从主线程交给 worker——不走 fetch，
 * 所以桌面端 CSP 的 `connect-src` 不用放开 `'self'`。两份 CSP 都不许编译 WebAssembly，所以关掉
 * wasm：JPEG 2000 / JBIG2 图像由 worker 从 `decoderPath` 按模块导入纯 JS 版解码器。
 *
 * PdfViewer 只认这里导出的类型（PdfDocument / PdfPage），不直接碰 pdf.js，测试替换这一个模块即可。
 */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  MAX_CANVAS_PIXELS,
  PDF_TO_CSS_UNITS,
  linkTargets,
  textRunsFromItems,
  type PdfAnnotationLike,
  type PdfLinkTarget,
  type PdfTextItemLike,
  type TextRun,
} from "../annotations/pdf-region.ts";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type DataFiles = Record<string, () => Promise<{ default: string }>>;
type DataIndex = { files: DataFiles; decoderPath: string };

/** A page's size at 100% zoom, in CSS pixels, rotation applied. */
export type PdfPageSize = { width: number; height: number; userUnit: number };
export type PdfTextItem = { str: string; eol: boolean };
export type PdfTask = { promise: Promise<void>; cancel: () => void };
export type PdfTextLayer = PdfTask & {
  /** The spans pdf.js made, one per text item, in `textItems()` order. */
  divs: () => HTMLElement[];
  update: (zoom: number) => void;
};

export interface PdfPage {
  readonly number: number;
  readonly size: PdfPageSize;
  /** Draw the page into `canvas` at `zoom` (1 = 100%), `outputScale` device pixels per CSS pixel. */
  render(canvas: HTMLCanvasElement, zoom: number, outputScale: number): PdfTask;
  /** The selectable text layer, into an empty container sized like the page. */
  renderText(container: HTMLElement, zoom: number): PdfTextLayer;
  textItems(): Promise<PdfTextItem[]>;
  textRuns(): Promise<TextRun[]>;
  links(): Promise<PdfLinkTarget[]>;
  /** The page drawn on a fresh canvas at `scale` × 100%, for a crop; null when it cannot be drawn. */
  snapshot(scale: number): Promise<HTMLCanvasElement | null>;
  /** Let go of what pdf.js holds for this page once it is off screen. */
  release(): void;
}

export interface PdfDocument {
  readonly numPages: number;
  page(n: number): Promise<PdfPage>;
  /** The 1-based page a link destination points at, or null. */
  destinationPage(dest: unknown): Promise<number | null>;
  destroy(): void;
}

export type PdfOpenErrorKind = "broken" | "failed" | "cancelled";
export class PdfOpenError extends Error {
  constructor(readonly kind: PdfOpenErrorKind, cause?: unknown) {
    super(`pdf: ${kind}`, { cause });
    this.name = "PdfOpenError";
  }
}

export type PdfOpenHooks = {
  /** The file is encrypted: call `submit` with a password; `wrong` when the last one did not open it. */
  onPassword: (submit: (password: string) => void, wrong: boolean) => void;
};

let loading: Promise<{ lib: PdfJs } & DataIndex> | null = null;

/** pdf.js, its worker and the data index, fetched once, on the first PDF. */
export function loadPdfJs(): Promise<{ lib: PdfJs } & DataIndex> {
  loading ??= (async () => {
    const [lib, worker, data] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
      // @ts-expect-error — a virtual module; `pdfjsData()` in vite.config.ts provides it.
      import("virtual:pdfjs-data") as Promise<DataIndex>,
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return { lib, files: data.files, decoderPath: data.decoderPath };
  })();
  // A failed chunk (offline, a new build) must not stick: the next PDF tries again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const DATA_DIRS: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts" };

/** pdf.js asks the main thread for CMaps and fonts by kind and file name; they come from the bundle. */
function dataFactory(files: DataFiles) {
  return class PdfDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const load = files[`${DATA_DIRS[kind] ?? "?"}/${filename}`];
      if (!load) throw new Error(`pdf.js data not bundled: ${kind} ${filename}`);
      return base64Bytes((await load()).default);
    }
  };
}

function canvasSize(width: number, height: number, ratio: number): { width: number; height: number; ratio: number } {
  let r = ratio;
  if (width * height * r * r > MAX_CANVAS_PIXELS) r = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return { width: Math.max(1, Math.floor(width * r)), height: Math.max(1, Math.floor(height * r)), ratio: r };
}

function wrapPage(lib: PdfJs, page: PDFPageProxy, number: number): PdfPage {
  const base = page.getViewport({ scale: PDF_TO_CSS_UNITS });
  const size: PdfPageSize = { width: base.width, height: base.height, userUnit: page.userUnit || 1 };
  // Marked-content entries carry no `str`; the text layer skips them too, so indices line up.
  const textContent = (): Promise<PdfTextItemLike[]> =>
    page.getTextContent().then((content) => content.items.filter((item) => "str" in item) as unknown as PdfTextItemLike[]);
  /** Kept per page for quotes and find; small (text and a box per run), dropped on `release()`. */
  let runs: Promise<TextRun[]> | null = null;
  return {
    number,
    size,
    render(canvas, zoom, outputScale) {
      const viewport = page.getViewport({ scale: zoom * PDF_TO_CSS_UNITS });
      const dims = canvasSize(viewport.width, viewport.height, outputScale);
      canvas.width = dims.width;
      canvas.height = dims.height;
      const transform = dims.ratio !== 1 ? [dims.ratio, 0, 0, dims.ratio, 0, 0] : undefined;
      const task = page.render({ canvas, viewport, transform });
      return { promise: task.promise.then(() => undefined), cancel: () => task.cancel() };
    },
    renderText(container, zoom) {
      const viewport = page.getViewport({ scale: zoom * PDF_TO_CSS_UNITS });
      const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      const promise = layer.render().then(() => {
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.append(end);
      });
      return {
        promise,
        cancel: () => layer.cancel(),
        divs: () => layer.textDivs,
        update: (next) => layer.update({ viewport: page.getViewport({ scale: next * PDF_TO_CSS_UNITS }) }),
      };
    },
    async textItems() {
      return (await textContent()).map((item) => ({ str: item.str, eol: item.hasEOL === true }));
    },
    textRuns() {
      runs ??= textContent().then((items) => textRunsFromItems(items, page.getViewport({ scale: 1 })));
      runs.catch(() => {
        runs = null;
      });
      return runs;
    },
    async links() {
      const annotations = (await page.getAnnotations({ intent: "display" })) as PdfAnnotationLike[];
      return linkTargets(annotations, page.getViewport({ scale: 1 }));
    },
    async snapshot(scale) {
      if (typeof document === "undefined") return null;
      const viewport = page.getViewport({ scale: scale * PDF_TO_CSS_UNITS });
      const canvas = document.createElement("canvas");
      const dims = canvasSize(viewport.width, viewport.height, 1);
      canvas.width = dims.width;
      canvas.height = dims.height;
      const transform = dims.ratio !== 1 ? [dims.ratio, 0, 0, dims.ratio, 0, 0] : undefined;
      try {
        await page.render({ canvas, viewport, transform }).promise;
      } catch {
        return null;
      }
      return canvas;
    },
    release() {
      runs = null;
      page.cleanup();
    },
  };
}

function wrapDocument(lib: PdfJs, pdf: PDFDocumentProxy, destroy: () => void): PdfDocument {
  const pages = new Map<number, Promise<PdfPage>>();
  return {
    numPages: pdf.numPages,
    page(n) {
      let found = pages.get(n);
      if (!found) {
        found = pdf.getPage(n).then((page) => wrapPage(lib, page, n));
        found.catch(() => pages.delete(n));
        pages.set(n, found);
      }
      return found;
    },
    async destinationPage(dest) {
      try {
        const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const ref = explicit[0];
        const index =
          typeof ref === "number" && Number.isInteger(ref)
            ? ref
            : ref && typeof ref === "object"
              ? await pdf.getPageIndex(ref as { num: number; gen: number })
              : null;
        if (index === null || index < 0 || index >= pdf.numPages) return null;
        return index + 1;
      } catch {
        return null;
      }
    },
    destroy,
  };
}

/**
 * Open a PDF held in memory. The promise settles with the document, or rejects with a
 * {@link PdfOpenError}: `broken` for a file pdf.js cannot parse, `failed` for anything else
 * (pdf.js did not load, the worker died), `cancelled` after `cancel()`.
 */
export function openPdf(data: Blob, hooks: PdfOpenHooks): { promise: Promise<PdfDocument>; cancel: () => void } {
  let cancelled = false;
  let task: ReturnType<PdfJs["getDocument"]> | null = null;
  const promise = (async () => {
    const { lib, files, decoderPath } = await loadPdfJs();
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (cancelled) throw new PdfOpenError("cancelled");
    const loadingTask = lib.getDocument({
      data: bytes,
      BinaryDataFactory: dataFactory(files),
      useWorkerFetch: false,
      cMapPacked: true,
      // CSP blocks wasm: without this every JPEG 2000 / JBIG2 image and PostScript function tries
      // it first and logs a violation. `wasmUrl` is then only where the JS decoders are imported from.
      useWasm: false,
      wasmUrl: new URL(decoderPath, location.href).href,
      enableXfa: false,
    });
    task = loadingTask;
    loadingTask.onPassword = (update: (password: string) => void, reason: number) => {
      if (cancelled) return;
      hooks.onPassword((password) => update(password), reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    };
    const pdf = await loadingTask.promise;
    if (cancelled) {
      void loadingTask.destroy();
      throw new PdfOpenError("cancelled");
    }
    return wrapDocument(lib, pdf, () => void loadingTask.destroy());
  })().catch((error: unknown) => {
    if (error instanceof PdfOpenError) throw error;
    if (cancelled) throw new PdfOpenError("cancelled", error);
    const name = (error as { name?: string } | null)?.name;
    throw new PdfOpenError(name === "InvalidPDFException" ? "broken" : "failed", error);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      void task?.destroy();
    },
  };
}
