import { BUTTON_RENDERER_VERSION, escapeXml, renderButton } from "../shared/button.js";
import type { SavedResponse } from "../shared/types.js";

export function printSheet(rows: SavedResponse[], face: number, cut: number, now: number): string {
	if (
		!Number.isFinite(face) ||
		face < 40 ||
		face > 80 ||
		!Number.isFinite(cut) ||
		cut < face ||
		cut > 100
	)
		throw Error(
			"Configure a face diameter (40–80 mm) and explicit cut diameter (face–100 mm); test against actual hardware.",
		);
	const eligible = rows.filter((row) => row.artwork && row.attendance !== "cant");
	const unapproved = eligible.filter(
		(row) => row.artwork?.rendererVersion !== BUTTON_RENDERER_VERSION || !row.artwork.label,
	).length;
	const artwork = eligible
		.filter((row) => row.artwork?.rendererVersion === BUTTON_RENDERER_VERSION && row.artwork.label)
		.map((row, index) => {
			const art = row.artwork;
			if (!art?.label) return "";
			return `<figure class="artwork"><div class="face">${renderButton({ ...art, label: art.label }, `print-${index}`)}</div></figure>`;
		})
		.join("");
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Provisional button print layout</title><style>@page{size:letter;margin:10mm}body{font:12px sans-serif}main{display:flex;flex-wrap:wrap;gap:4mm}.artwork{position:relative;width:${cut}mm;height:${cut}mm;border:0.2mm dashed #555;box-sizing:border-box;border-radius:50%;overflow:hidden;margin:0;break-inside:avoid;display:grid;place-items:center;background:#ddd}.face{width:${face}mm;height:${face}mm}.face svg{display:block;width:100%;height:100%}.test-note{font-size:10px}@media print{header{display:none}}</style><header><h1>Provisional home-print artwork</h1><p>Snapshot ${escapeXml(new Date(now).toISOString())}. Visible face ${face} mm; paper cut ${cut} mm. These are configured test dimensions, not a verified press template. Print at 100%, no scaling. Test one against the actual cutter/press before using this batch. This is not a printed/completed record. Re-export before printing to reflect withdrawals. Keep this file private and delete it under the agreed retention policy.</p><p>${unapproved} older requests omitted: attendees must preview and approve the updated design before export.</p></header><p class="test-note">PROVISIONAL — test configured ${face} mm face / ${cut} mm cut against actual hardware. Not a verified production template.</p><main>${artwork}</main></html>`;
}
