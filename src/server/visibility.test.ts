import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { parseResponse } from "./policy.js";
import { Store } from "./store.js";

it("validates visibility without silently defaulting invalid choices", () => {
	for (const visibility of [
		"private",
		"loggedin",
		"public",
		"followers",
		"following",
		"either",
		"mutuals",
	])
		expect(parseResponse({ attendance: "coming", button: null, visibility })).not.toBeNull();
	for (const visibility of [null, false, {}, "friends", "PUBLIC"])
		expect(parseResponse({ attendance: "coming", button: null, visibility })).toBeNull();
});
it("keeps legacy private and checks save/narrow/delete histories against independent SQL values", () => {
	const dir = mkdtempSync(join(tmpdir(), "visibility-"));
	const path = join(dir, "test.sqlite");
	const store = new Store(path);
	const oracle = new DatabaseSync(path);
	oracle.exec("PRAGMA synchronous=NORMAL");
	const profile = { did: "did:plc:synthetic", handle: "synthetic.test", avatar: null };
	try {
		oracle
			.prepare("INSERT INTO responses VALUES (?,?)")
			.run(
				profile.did,
				JSON.stringify({ ...profile, attendance: "coming", artwork: null, updatedAt: 1 }),
			);
		expect(store.get(profile.did)?.visibility).toBe("private");
		let expected = "private";
		let seed = 4567;
		const choices = ["private", "public", "followers", "mutuals"] as const;
		for (let i = 0; i < 80; i++) {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			const op = seed % 5;
			const version = store.version(profile.did);
			if (op === 0) {
				store.cancel(profile.did, version);
				expected = "private";
			} else if (op === 1 && store.get(profile.did)) {
				const choice = choices[(seed >>> 8) % 4]!;
				expect(store.setVisibility(profile.did, choice, version)).toBe(true);
				expected = choice;
			} else {
				const choice = op === 2 ? choices[(seed >>> 8) % 4]! : undefined;
				store.save(
					profile,
					{
						attendance: i % 2 ? "maybe" : "coming",
						button: null,
						...(choice ? { visibility: choice } : {}),
					},
					i + 2,
					version,
				);
				expected = choice ?? expected;
			}
			const raw = oracle.prepare("SELECT value FROM responses WHERE did=?").get(profile.did);
			expect(raw ? (JSON.parse(String(raw.value)).visibility ?? "private") : "private").toBe(
				expected,
			);
			expect(store.get(profile.did)?.visibility ?? "private").toBe(expected);
			expect(store.setVisibility(profile.did, "public", version)).toBe(false);
		}
	} finally {
		oracle.close();
		store.close();
		rmSync(dir, { recursive: true });
	}
}, 15000);
