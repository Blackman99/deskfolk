import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { injectHtmlPreviewNonce, pageCspNonce } from '../artifacts.ts';

/** External relationships are never fetched or navigated by an Office preview. */
export function localOfficeData(data: ArrayBuffer): ArrayBuffer {
	const files = unzipSync(new Uint8Array(data));
	for (const [path, bytes] of Object.entries(files)) {
		if (!path.endsWith('.rels')) continue;
		const xml = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
		if (xml.querySelector('parsererror')) throw new Error('office-invalid');
		for (const rel of [...xml.getElementsByTagNameNS('*', 'Relationship')]) {
			const target = rel.getAttribute('Target') ?? '';
			if (rel.getAttribute('TargetMode')?.toLowerCase() === 'external' || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) rel.remove();
		}
		files[path] = strToU8(new XMLSerializer().serializeToString(xml));
	}
	return zipSync(files, { level: 0 }).buffer;
}

/** Scripts, navigation and external resources stay disabled in the rendered document. */
export async function documentFrame(host: HTMLElement, title: string, signal: AbortSignal): Promise<HTMLElement> {
	const frame = document.createElement('iframe');
	frame.title = title;
	frame.setAttribute('sandbox', 'allow-same-origin');
	frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;';
	const html = injectHtmlPreviewNonce(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;color:#171717;background:var(--office-fill,#eef2f6);font-family:system-ui,sans-serif}*{box-sizing:border-box}#office{min-height:100%;overflow:auto}.slides,.slides body{height:100%}.slides #office{display:flex;flex-direction:column;justify-content:center;height:100%;overflow:hidden}.slides #office>*{flex:none}.docx-wrapper{padding:16px!important;background:transparent!important}.docx-wrapper>section.docx{margin-bottom:16px!important}a{pointer-events:none;color:inherit}img{max-width:100%}@media(max-width:600px){.docx-wrapper{padding:8px!important}.docx-wrapper>section.docx{padding:24px!important}}</style></head><body><main id="office"></main></body></html>`, pageCspNonce());
	const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
	try {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); frame.onload = null; frame.onerror = null; };
			const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
			const timer = setTimeout(() => { cleanup(); reject(new Error('office-frame')); }, 15000);
			frame.onload = () => { cleanup(); resolve(); };
			frame.onerror = () => { cleanup(); reject(new Error('office-frame')); };
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) { abort(); return; }
			frame.src = url;
			host.replaceChildren(frame);
		});
		const root = frame.contentDocument?.getElementById('office');
		if (!root) throw new Error('office-frame');
		paintOfficeFill(root.ownerDocument, host);
		return root;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Around the pages and below a slide is the messenger's page colour, read from `from`, so it
 * follows the theme. The paper itself stays white in both, like a PDF's.
 */
export function paintOfficeFill(frame: Document, from: Element): void {
	const style = getComputedStyle(from);
	const root = frame.documentElement;
	root.style.setProperty('--office-fill', style.getPropertyValue('--bg').trim() || '#eef2f6');
	root.style.colorScheme = style.colorScheme === 'dark' ? 'dark' : 'light';
}
