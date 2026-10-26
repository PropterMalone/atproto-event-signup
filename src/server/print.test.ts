import { expect, it } from "vitest";
import { renderButton } from "../shared/button.js";
import { printSheet } from "./print.js";

const row = {
	did: "did:plc:private",
	handle: "private",
	attendance: "coming" as const,
	updatedAt: 1,
	artwork: {
		avatar: "data:image/png;base64,AA==",
		handle: "verified.test",
		label: '@A "&<👋',
		rendererVersion: 3,
		color: "black" as const,
		position: "top" as const,
		style: "handle" as const,
		approvedAt: 1,
	},
};
it("exports only approved nondeclined artwork using exactly shared preview geometry and unique ids", () => {
	const html = printSheet(
		[row, row, { ...row, artwork: null }, { ...row, attendance: "cant" }],
		58,
		70,
		123,
	);
	expect(html.match(/class="artwork"/g)).toHaveLength(2);
	expect(html).toContain(renderButton(row.artwork, "print-0"));
	expect(html).toContain('id="print-1-arc"');
	expect(html).toContain("@A &quot;&amp;&lt;👋");
	expect(html).not.toContain(row.did);
	expect(html).toContain("width:58mm");
	expect(html).toContain("width:70mm");
	expect(html).toContain("PROVISIONAL");
	expect(
		printSheet(
			[{ ...row, artwork: { ...row.artwork, style: "pfp", avatar: "javascript:bad" } }],
			58,
			70,
			123,
		),
	).not.toContain("javascript:");
	expect(
		printSheet([{ ...row, artwork: { ...row.artwork, style: "pfp" } }], 58, 70, 123),
	).not.toContain("<text");
});
it("omits old unapproved layouts and rejects ambiguous or nonsensical cut sizing", () => {
	const { rendererVersion: _version, ...legacy } = row.artwork;
	expect(printSheet([{ ...row, artwork: legacy }], 58, 70, 123)).not.toContain('class="artwork"');
	expect(
		printSheet([{ ...row, artwork: { ...legacy, rendererVersion: 1 } }], 58, 70, 123),
	).not.toContain('class="artwork"');
	expect(
		printSheet([{ ...row, artwork: { ...legacy, rendererVersion: 2 } }], 58, 70, 123),
	).not.toContain('class="artwork"');
	for (const cut of [NaN, 57, 101]) expect(() => printSheet([row], 58, cut, 123)).toThrow();
});
