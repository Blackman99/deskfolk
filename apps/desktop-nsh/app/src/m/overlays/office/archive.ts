import { unzipSync } from 'fflate';

export type OfficeKind = 'word' | 'spreadsheet' | 'presentation';
export const OFFICE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;

/** Check ZIP metadata before handing an untrusted package to a renderer. */
export function checkOfficeArchive(data: ArrayBuffer, kind: OfficeKind): void {
	if (data.byteLength > OFFICE_MAX_BYTES) throw new Error('office-limit');
	let entries = 0;
	let expanded = 0;
	const names = new Set<string>();
	unzipSync(new Uint8Array(data), {
		filter(file) {
			entries++;
			expanded += file.originalSize;
			if (entries > 4000 || file.originalSize > MAX_ENTRY || expanded > MAX_EXPANDED) {
				throw new Error('office-limit');
			}
			names.add(file.name);
			return false;
		}
	});
	const main = { word: 'word/document.xml', spreadsheet: 'xl/workbook.xml', presentation: 'ppt/presentation.xml' }[kind];
	if (!names.has('[Content_Types].xml') || !names.has(main)) throw new Error('office-invalid');
}
