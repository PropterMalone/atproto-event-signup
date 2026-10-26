import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshot } from "./backup.js";
import { Store } from "./store.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "dcbsky-backup-"));
	roots.push(root);
	const dataDirectory = join(root, "data");
	const backupDirectory = join(root, "backups");
	mkdirSync(dataDirectory);
	writeFileSync(join(dataDirectory, "oauth-key.json"), '{"stable":"private-key"}');
	const store = new Store(join(dataDirectory, "app.sqlite"));
	return { dataDirectory, backupDirectory, store, artworkDeleteAt: 1000000000 };
}
describe("private online backups", () => {
	it("backs up live WAL data and the unchanged key with private permissions", async () => {
		const options = setup();
		const profile = {
			did: "did:plc:test",
			handle: "test.bsky.social",
			displayName: "Test",
			avatar: null,
		};
		options.store.setPreference(profile, true, 100, options.store.version(profile.did));
		const path = await createSnapshot({ ...options, now: 100 });
		const restored = new Store(join(path, "app.sqlite"));
		expect(restored.futureContacts()).toEqual([
			{ did: profile.did, handle: profile.handle, optedAt: 100 },
		]);
		expect(readFileSync(join(path, "oauth-key.json"), "utf8")).toBe('{"stable":"private-key"}');
		for (const directory of [options.backupDirectory, path])
			expect(statSync(directory).mode & 0o777).toBe(0o700);
		for (const file of ["app.sqlite", "oauth-key.json"])
			expect(statSync(join(path, file)).mode & 0o777).toBe(0o600);
		restored.close();
		options.store.close();
	});
	it("caps snapshots at seven and expires them after seven days", async () => {
		const options = setup();
		for (let i = 0; i < 9; i++) await createSnapshot({ ...options, now: 100 + i });
		expect(readdirSync(options.backupDirectory)).toHaveLength(7);
		await createSnapshot({ ...options, now: 100 + 7 * 86400000 + 9 });
		expect(readdirSync(options.backupDirectory)).toHaveLength(1);
		options.store.close();
	});
	it("deletes pre-deadline backups and sanitizes new snapshots without deleting attendance or contacts", async () => {
		const options = setup();
		const db = new DatabaseSync(options.store.path);
		const marker = "PRIVATE_IMAGE_BYTES_DO_NOT_RETAIN";
		db.prepare("INSERT INTO future_contacts VALUES(?,?,?)").run(
			"did:plc:test",
			"test.bsky.social",
			100,
		);
		db.prepare("INSERT INTO responses VALUES(?,?)").run(
			"did:plc:test",
			JSON.stringify({ did: "did:plc:test", attendance: "coming", artwork: { avatar: marker } }),
		);
		db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
			"session",
			JSON.stringify({ profile: { avatar: marker } }),
			2000000000,
		);
		db.prepare("INSERT INTO oauth VALUES(?,?,?,?)").run("expired", "secret", marker, 10);
		const old = await createSnapshot({ ...options, now: options.artworkDeleteAt - 1 });
		expect(statSync(old).isDirectory()).toBe(true);
		const path = await createSnapshot({ ...options, now: options.artworkDeleteAt });
		expect(readdirSync(options.backupDirectory)).toEqual([path.split("/").at(-1)]);
		const restored = new Store(join(path, "app.sqlite"));
		expect(restored.get("did:plc:test")?.attendance).toBe("coming");
		expect(restored.get("did:plc:test")?.artwork).toBeNull();
		expect(restored.futureContacts()).toHaveLength(1);
		const snapshotDb = new DatabaseSync(join(path, "app.sqlite"));
		expect(snapshotDb.prepare("SELECT count(*) AS n FROM oauth").get()?.n).toBe(0);
		expect(snapshotDb.prepare("SELECT value FROM sessions").get()?.value).not.toContain(marker);
		snapshotDb.close();
		expect(readFileSync(join(path, "app.sqlite")).includes(Buffer.from(marker))).toBe(false);
		restored.close();
		db.close();
		options.store.close();
	});
	it("fails closed and removes old backups if the deletion deadline elapses during backup", async () => {
		const options = setup();
		await createSnapshot({ ...options, now: options.artworkDeleteAt - 1 });
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(options.artworkDeleteAt - 1)
			.mockReturnValueOnce(options.artworkDeleteAt - 1)
			.mockReturnValueOnce(options.artworkDeleteAt - 1)
			.mockReturnValue(options.artworkDeleteAt);
		await expect(createSnapshot(options)).rejects.toThrow("deadline elapsed");
		expect(readdirSync(options.backupDirectory)).toEqual([]);
		options.store.close();
	});
	it("refuses missing source/key and unsafe backup paths", async () => {
		const options = setup();
		await expect(
			createSnapshot({ ...options, backupDirectory: options.dataDirectory, now: 100 }),
		).rejects.toThrow();
		await expect(
			createSnapshot({
				...options,
				backupDirectory: join(options.dataDirectory, "public", "backups"),
				now: 100,
			}),
		).rejects.toThrow();
		rmSync(join(options.dataDirectory, "oauth-key.json"));
		await expect(createSnapshot({ ...options, now: 100 })).rejects.toThrow();
		options.store.close();
	});
});
