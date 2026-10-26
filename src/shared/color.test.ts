import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseResponse } from "../server/policy.js";
import { Store } from "../server/store.js";
import { buttonApproval, renderButton } from "./button.js";

it("defaults missing color to white and swaps only text colors for black", () => {
	const art = { avatar: "", style: "handle" as const, label: '@A "&<👋', position: "top" as const };
	const white = renderButton({ ...art, color: "white" }, "color");
	const black = renderButton({ ...art, color: "black" }, "color");
	expect(renderButton(art, "color")).toBe(white);
	expect(black).toContain('fill="black" stroke="white" stroke-width="0.3"');
	expect(black).toContain("@A &quot;&amp;&lt;👋");
	expect(black).toContain('font-size="3.2" font-weight="600"');
	expect(black).toContain('d="M 4.5 29 A 24.5 24.5 0 0 1 53.5 29"');
	expect(black.replace('fill="black" stroke="white"', 'fill="white" stroke="black"')).toBe(white);
	for (const rendererVersion of [1, 2]) {
		const old = renderButton({ ...art, rendererVersion, color: "black" }, "color");
		expect(old).toContain('fill="white" stroke="black"');
		expect(old).toContain(`data-renderer="${rendererVersion}"`);
	}
	expect(renderButton({ ...art, rendererVersion: 2 }, "color")).toBe(
		white.replace('data-renderer="3"', 'data-renderer="2"'),
	);
});
it("binds current approval to color, with white as the omitted default", () => {
	const white = buttonApproval("source", "handle", "Friend", "top", "white");
	expect(buttonApproval("source", "handle", "Friend", "top")).toBe(white);
	expect(JSON.parse(white)).toEqual([3, "source", "handle", "Friend", "top", "white"]);
	expect(buttonApproval("source", "handle", "Friend", "top", "black")).not.toBe(white);
});
it("accepts only lowercase white or black and leaves absent old colors absent", () => {
	for (const color of ["white", "black"])
		expect(parseResponse({ attendance: null, button: "handle", color })).toMatchObject({ color });
	for (const color of [null, false, 1, "red", "BLACK", {}, ["white"], "white;fill:red"])
		expect(parseResponse({ attendance: null, button: "handle", color })).toBeNull();
	expect(parseResponse({ attendance: null, button: "handle" })).not.toHaveProperty("color");
});
it("persists color approval, defaults white, and preserves version 2 until an explicit edit", () => {
	const dir = mkdtempSync(join(tmpdir(), "dcbsky-color-"));
	const path = join(dir, "test.sqlite");
	const profile = {
		did: "did:plc:synthetic",
		handle: "full.bsky.social",
		avatar: "data:image/png;base64,AA==",
	};
	let db = new Store(path);
	try {
		const first = db.save(
			profile,
			{ attendance: "coming", button: "handle", label: "Friend" },
			1,
			"0",
		);
		expect(first?.artwork).toMatchObject({ color: "white", rendererVersion: 3, approvedAt: 1 });
		const black = db.save(
			profile,
			{ attendance: "coming", button: "handle", color: "black" },
			2,
			db.version(profile.did),
		);
		expect(black?.artwork).toMatchObject({ color: "black", rendererVersion: 3, approvedAt: 2 });
		expect(
			db.save(profile, { attendance: "coming", button: "handle", color: "white" }, 3, "0"),
		).toBeNull();
		const same = db.save(
			profile,
			{ attendance: "maybe", button: "handle", color: "black" },
			3,
			db.version(profile.did),
		);
		expect(same?.artwork).toEqual(black?.artwork);
		db.close();
		db = new Store(path);
		expect(db.get(profile.did)?.artwork).toEqual(black?.artwork);
		const legacy = { ...first, artwork: { ...first?.artwork, rendererVersion: 2 } };
		if (legacy.artwork) delete legacy.artwork.color;
		const raw = new DatabaseSync(path);
		try {
			raw
				.prepare("UPDATE responses SET value=? WHERE did=?")
				.run(JSON.stringify(legacy), profile.did);
		} finally {
			raw.close();
		}
		expect(db.get(profile.did)?.artwork).toEqual(legacy.artwork);
		const preserved = db.save(
			profile,
			{ attendance: "maybe", button: "handle", futureMeetups: true },
			4,
			db.version(profile.did),
		);
		expect(preserved?.artwork).toEqual(legacy.artwork);
		expect(db.setPreference(profile, false, 5, db.version(profile.did))).toBe(true);
		expect(db.get(profile.did)?.artwork).toEqual(legacy.artwork);
		const upgraded = db.save(
			profile,
			{ attendance: "maybe", button: "handle", color: "white" },
			6,
			db.version(profile.did),
		);
		expect(upgraded?.artwork).toMatchObject({ color: "white", rendererVersion: 3, approvedAt: 6 });
		expect(upgraded?.artwork?.handle).toBe(profile.handle);
	} finally {
		db.close();
		rmSync(dir, { recursive: true });
	}
});
