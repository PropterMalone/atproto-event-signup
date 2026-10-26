import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile, ResponseInput } from "../shared/types.js";
import { Store } from "./store.js";

const dirs: string[] = [];
function database() {
	const dir = mkdtempSync(join(tmpdir(), "dcbsky-test-"));
	dirs.push(dir);
	return new Store(join(dir, "test.sqlite"));
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const profile = {
	did: "did:plc:alice",
	handle: "alice.test",
	avatar: "data:image/png;base64,aGVsbG8=",
};
function save(db: Store, who: Profile, input: ResponseInput, now: number) {
	return db.save(who, input, now, db.version(who.did));
}
describe("durable individual responses and separate consent", () => {
	it("reads old artwork unchanged, then snapshots its shortened default only on explicit save", () => {
		let db = database();
		const path = db.path;
		db.close();
		const raw = new DatabaseSync(path);
		const artwork = {
			avatar: profile.avatar,
			handle: "friend.BSKY.SOCIAL",
			style: "handle",
			approvedAt: 1,
		};
		const old = {
			did: profile.did,
			handle: artwork.handle,
			attendance: "coming",
			artwork,
			updatedAt: 1,
		};
		const bytes = JSON.stringify(old);
		raw.prepare("INSERT INTO responses VALUES(?,?)").run(profile.did, bytes);
		db = new Store(path);
		expect(db.get(profile.did)).toEqual(old);
		expect(raw.prepare("SELECT value FROM responses WHERE did=?").get(profile.did)?.value).toBe(
			bytes,
		);
		const unchanged = save(db, profile, { attendance: "maybe", button: "handle" }, 2);
		expect(unchanged?.artwork).toEqual(artwork);
		const saved = save(
			db,
			{ ...profile, handle: "new.example" },
			{ attendance: "coming", button: "handle", label: "@friend" },
			2,
		);
		expect(saved?.artwork).toMatchObject({
			label: "@friend",
			handle: artwork.handle,
			avatar: artwork.avatar,
			approvedAt: 2,
			rendererVersion: 3,
			position: "bottom",
			color: "white",
		});
		const changed = save(
			db,
			profile,
			{ attendance: "coming", button: "handle", label: "Chosen" },
			3,
		);
		expect(changed?.artwork?.approvedAt).toBe(3);
		const replaced = save(
			db,
			{ ...profile, handle: "new.example" },
			{ attendance: "coming", button: "handle", replaceArtwork: true },
			4,
		);
		expect(replaced?.artwork?.label).toBe("Chosen");
		expect(replaced?.artwork?.handle).toBe("new.example");
		raw.close();
		db.close();
	});
	it("keeps version-1 approval without position until explicit artwork approval", () => {
		let db = database();
		const path = db.path;
		db.close();
		const raw = new DatabaseSync(path);
		const old = {
			did: profile.did,
			handle: profile.handle,
			attendance: "coming",
			updatedAt: 1,
			artwork: {
				avatar: profile.avatar,
				handle: profile.handle,
				style: "handle",
				label: "Friend",
				rendererVersion: 1,
				approvedAt: 1,
			},
		};
		raw.prepare("INSERT INTO responses VALUES(?,?)").run(profile.did, JSON.stringify(old));
		db = new Store(path);
		expect(db.get(profile.did)).toEqual(old);
		expect(
			save(db, profile, { attendance: "maybe", button: "handle", futureMeetups: true }, 2)?.artwork,
		).toEqual(old.artwork);
		const upgraded = save(
			db,
			profile,
			{ attendance: "maybe", button: "handle", position: "bottom" },
			3,
		);
		expect(upgraded?.artwork).toMatchObject({
			...old.artwork,
			position: "bottom",
			color: "white",
			rendererVersion: 3,
			approvedAt: 3,
		});
		raw.close();
		db.close();
	});
	it("persists text position, refreshes approval on edits, and preserves it for unrelated saves", () => {
		let db = database();
		const path = db.path;
		const first = save(db, profile, { attendance: "coming", button: "handle", label: "Friend" }, 1);
		expect(first?.artwork).toMatchObject({
			position: "bottom",
			color: "white",
			rendererVersion: 3,
			approvedAt: 1,
		});
		const top = save(db, profile, { attendance: "coming", button: "handle", position: "top" }, 2);
		expect(top?.artwork).toMatchObject({ position: "top", approvedAt: 2 });
		expect(top?.artwork?.avatar).toBe(first?.artwork?.avatar);
		const unchanged = save(
			db,
			profile,
			{ attendance: "maybe", button: "handle", futureMeetups: true },
			3,
		);
		expect(unchanged?.artwork).toEqual(top?.artwork);
		const same = save(db, profile, { attendance: "maybe", button: "handle", position: "top" }, 4);
		expect(same?.artwork?.approvedAt).toBe(2);
		db.close();
		db = new Store(path);
		expect(db.get(profile.did)?.artwork).toEqual(top?.artwork);
		db.close();
	});
	it("keeps future contact consent independent, minimal, durable and versioned", () => {
		let db = database();
		const path = db.path;
		expect(db.preference(profile.did)).toBeNull();
		const start = db.version(profile.did);
		expect(db.setPreference(profile, true, 50, start)).toBe(true);
		expect(db.get(profile.did)).toBeNull();
		expect(db.setPreference(profile, false, 60, start)).toBe(false);
		expect(db.futureContacts()).toEqual([
			{ did: profile.did, handle: profile.handle, optedAt: 50 },
		]);
		save(db, profile, { attendance: "cant", button: null }, 100);
		expect(db.preference(profile.did)?.optedAt).toBe(50);
		const before = db.version(profile.did);
		expect(db.cancel(profile.did, before)).toBe(true);
		expect(db.preference(profile.did)?.optedAt).toBe(50);
		expect(db.setPreference(profile, false, 110, before)).toBe(false);
		save(
			db,
			{ ...profile, handle: "new.test" },
			{ attendance: "coming", button: "pfp", futureMeetups: true },
			200,
		);
		db.purge(86400100, 500);
		expect(db.preference(profile.did)).toEqual({
			did: profile.did,
			handle: "new.test",
			optedAt: 50,
		});
		db.close();
		db = new Store(path);
		expect(db.futureContacts()).toHaveLength(1);
		expect(db.setPreference(profile, false, 300, db.version(profile.did))).toBe(true);
		expect(db.futureContacts()).toEqual([]);
		expect(db.get(profile.did)?.attendance).toBe("coming");
		expect(db.setPreference(profile, true, 400, db.version(profile.did))).toBe(true);
		expect(db.preference(profile.did)?.optedAt).toBe(400);
		const deleteVersion = db.version(profile.did);
		expect(db.cancel(profile.did, deleteVersion, true)).toBe(true);
		expect(db.preference(profile.did)).toBeNull();
		expect(db.setPreference(profile, true, 500, deleteVersion)).toBe(false);
		db.close();
	});
	it("adds contact storage to the previous schema without changing responses or versions", () => {
		const dir = mkdtempSync(join(tmpdir(), "dcbsky-legacy-"));
		dirs.push(dir);
		const path = join(dir, "legacy.sqlite");
		const legacy = new DatabaseSync(path);
		legacy.exec(
			"CREATE TABLE responses(did TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE response_versions(subject TEXT PRIMARY KEY, version TEXT NOT NULL);",
		);
		const response = {
			did: profile.did,
			handle: profile.handle,
			attendance: "maybe",
			artwork: null,
			updatedAt: 10,
		};
		legacy.prepare("INSERT INTO responses VALUES(?,?)").run(profile.did, JSON.stringify(response));
		legacy.close();
		const db = new Store(path);
		expect(db.get(profile.did)).toEqual(response);
		expect(db.futureContacts()).toEqual([]);
		expect(db.version(profile.did)).toBe("0");
		expect(db.setPreference(profile, true, 100, "0")).toBe(true);
		expect(db.get(profile.did)).toEqual(response);
		db.close();
	});
	it("rolls back preference changes with a failed event write", () => {
		const db = database();
		let reads = 0;
		const invalid = {
			...profile,
			get handle(): string {
				if (++reads === 1) return profile.handle;
				throw Error("broken contact");
			},
		};
		expect(() =>
			db.save(invalid, { attendance: null, button: null, futureMeetups: true }, 100, "0"),
		).toThrow();
		expect(db.preference(profile.did)).toBeNull();
		expect(db.version(profile.did)).toBe("0");
		db.close();
	});
	it("rejects stale consent after replacement, opt-out, delete/recreate, and retention cleanup", () => {
		let db = database();
		const path = db.path;
		const initial = db.version(profile.did);
		const input = { attendance: "coming", button: "pfp" } as const;
		expect(db.save(profile, input, 100, initial)).not.toBeNull();
		const first = db.version(profile.did);
		save(db, { ...profile, avatar: "replacement" }, { ...input, replaceArtwork: true }, 200);
		expect(db.save(profile, input, 300, first)).toBeNull();
		const replaced = db.version(profile.did);
		save(db, profile, { ...input, button: null }, 400);
		expect(db.save(profile, input, 500, replaced)).toBeNull();
		const beforeDelete = db.version(profile.did);
		expect(db.cancel(profile.did, beforeDelete)).toBe(true);
		expect(db.cancel(profile.did, beforeDelete)).toBe(false);
		db.close();
		db = new Store(path);
		expect(db.save(profile, input, 600, initial)).toBeNull();
		expect(db.save(profile, input, 600, beforeDelete)).toBeNull();
		const absent = db.version(profile.did);
		expect(db.save(profile, input, 700, absent)).not.toBeNull();
		expect(db.save(profile, input, 700, absent)).toBeNull();
		const beforePurge = db.version(profile.did);
		db.purge(1000, 500);
		expect(db.save(profile, input, 1000, beforePurge)).toBeNull();
		db.close();
	});
	it("rolls back failed writes without advancing the version", () => {
		const db = database();
		const version = db.version(profile.did);
		const invalid = {
			...profile,
			get handle(): string {
				throw Error("broken snapshot");
			},
		};
		expect(() => db.save(invalid, { attendance: "coming", button: null }, 100, version)).toThrow(
			"broken snapshot",
		);
		expect(db.version(profile.did)).toBe(version);
		expect(save(db, profile, { attendance: "coming", button: null }, 100)).not.toBeNull();
		db.close();
	});
	it("upserts a single DID, preserves approved artwork until explicit replacement, and survives restart", () => {
		let db = database();
		const path = db.path;
		save(db, profile, { attendance: "coming", button: "handle" }, 100);
		save(
			db,
			{ ...profile, handle: "renamed.test", avatar: "different" },
			{ attendance: "maybe", button: "handle" },
			200,
		);
		expect(db.list()).toHaveLength(1);
		expect(db.get(profile.did)?.artwork?.handle).toBe("alice.test");
		const version = db.version(profile.did);
		db.close();
		db = new Store(path);
		expect(db.version(profile.did)).toBe(version);
		expect(db.get(profile.did)?.attendance).toBe("maybe");
		save(
			db,
			{ ...profile, handle: "new.test" },
			{ attendance: null, button: "pfp", replaceArtwork: true },
			300,
		);
		expect(db.get(profile.did)?.artwork?.handle).toBe("new.test");
		expect(db.eligible()).toHaveLength(1);
		db.close();
	});
	it("counts attendance separately from button-only requests and erases opt-out/cancellation", () => {
		const db = database();
		save(db, profile, { attendance: "coming", button: null }, 100);
		save(db, { ...profile, did: "did:plc:bob" }, { attendance: "maybe", button: null }, 100);
		save(db, { ...profile, did: "did:plc:carol" }, { attendance: "cant", button: "pfp" }, 100);
		save(db, { ...profile, did: "did:plc:dora" }, { attendance: null, button: "handle" }, 100);
		expect(db.counts()).toEqual({ coming: 1, maybe: 1, cant: 1, buttons: 1, futureMeetups: 0 });
		expect(db.get("did:plc:carol")?.artwork).toBeNull();
		save(db, profile, { attendance: "coming", button: "pfp" }, 200);
		save(db, profile, { attendance: "maybe", button: "handle" }, 250);
		save(db, profile, { attendance: "cant", button: null }, 300);
		expect(db.get(profile.did)?.artwork).toBeNull();
		db.cancel(profile.did, db.version(profile.did));
		expect(db.get(profile.did)).toBeNull();
		db.cancel("missing", "0");
		expect(db.eligible()).toHaveLength(1);
		db.close();
	});
	it("expires sessions, OAuth state and retained artwork without losing attendance", async () => {
		const db = database();
		const token = db.createSession(profile, 100);
		expect(db.session(token, 101)?.profile.did).toBe(profile.did);
		expect(db.session("forged", 101)).toBeNull();
		const clock = vi.spyOn(Date, "now").mockReturnValue(100);
		const kv = db.oauthStore<{ value: string }>("state", 10);
		await kv.set("x", { value: "secret" });
		await kv.set("x", { value: "updated" });
		expect(await kv.get("x")).toEqual({ value: "updated" });
		clock.mockReturnValue(111);
		expect(await kv.get("x")).toBeUndefined();
		clock.mockRestore();
		await kv.del("x");
		expect(await kv.get("x")).toBeUndefined();
		save(db, profile, { attendance: "coming", button: "pfp", futureMeetups: true }, 100);
		db.purge(1000, 500);
		expect(db.preference(profile.did)?.optedAt).toBe(100);
		expect(db.get(profile.did)?.attendance).toBe("coming");
		expect(db.get(profile.did)?.artwork).toBeNull();
		expect(db.session(token, 1000)?.profile.avatar).toBeNull();
		const live = db.createSession(profile, 1000);
		db.deleteSession(live);
		expect(db.session(live, 1001)).toBeNull();
		db.purge(100 + 86400001, 500);
		expect(db.session(token, 100 + 86400001)).toBeNull();
		expect(db.preference(profile.did)?.optedAt).toBe(100);
		db.close();
	});
});
