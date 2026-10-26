import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";

interface SnapshotOptions {
	dataDirectory: string;
	backupDirectory: string;
	artworkDeleteAt: number;
	publicDirectory?: string;
	now?: number;
}
const day = 86400000;
const snapshotName = /^(\d+)-[0-9a-f-]{36}$/;
function within(path: string, root: string) {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
function prune(directory: string, now: number, deletion: number, keep = 7) {
	// Runs must be serialized; remove incomplete snapshots left by an interrupted run.
	for (const name of readdirSync(directory))
		if (/^\.pending-[0-9a-f-]{36}$/.test(name))
			rmSync(resolve(directory, name), { recursive: true, force: true });
	const snapshots = readdirSync(directory)
		.map((name) => ({ name, time: Number(snapshotName.exec(name)?.[1]) }))
		.filter((entry) => Number.isFinite(entry.time))
		.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
	let retained = 0;
	for (const entry of snapshots) {
		if (
			now - entry.time >= 7 * day ||
			(now >= deletion && entry.time < deletion) ||
			retained >= keep
		)
			rmSync(resolve(directory, entry.name), { recursive: true, force: true });
		else retained++;
	}
}

export async function createSnapshot(options: SnapshotOptions): Promise<string> {
	const clock = () => options.now ?? Date.now();
	if (!Number.isFinite(options.artworkDeleteAt)) throw Error("Backup requires ARTWORK_DELETE_AT");
	const dataDirectory = realpathSync(options.dataDirectory);
	const requested = resolve(options.backupDirectory);
	const publicDirectories = [
		resolve("public"),
		resolve("dist/public"),
		...(options.publicDirectory ? [resolve(options.publicDirectory)] : []),
	];
	function validateDestination(destination: string) {
		if (
			within(destination, dataDirectory) ||
			within(dataDirectory, destination) ||
			publicDirectories.some((directory) => within(destination, directory)) ||
			destination.split("/").includes("public")
		)
			throw Error("BACKUP_DIR must be private, outside DATA_DIR and public assets");
	}
	validateDestination(requested);
	mkdirSync(requested, { recursive: true, mode: 0o700 });
	const directory = realpathSync(requested);
	validateDestination(directory);
	chmodSync(directory, 0o700);
	prune(directory, clock(), options.artworkDeleteAt);
	const database = resolve(dataDirectory, "app.sqlite");
	const key = resolve(dataDirectory, "oauth-key.json");
	if (!lstatSync(database).isFile() || !lstatSync(key).isFile())
		throw Error("Existing database and signing key required");
	const temporary = resolve(directory, `.pending-${randomUUID()}`);
	mkdirSync(temporary, { mode: 0o700 });
	try {
		const source = new Store(database);
		try {
			source.purge(clock(), options.artworkDeleteAt);
		} finally {
			source.close();
		}
		const snapshot = resolve(temporary, "app.sqlite");
		writeFileSync(snapshot, "", { mode: 0o600, flag: "wx" });
		const connection = new DatabaseSync(database);
		try {
			await backup(connection, snapshot);
		} finally {
			connection.close();
		}
		// Recheck after the copy in case the deletion deadline elapsed during backup.
		const saved = new Store(snapshot);
		const sanitizedAt = clock();
		try {
			saved.purge(sanitizedAt, options.artworkDeleteAt);
		} finally {
			saved.close();
		}
		const compact = new DatabaseSync(snapshot);
		try {
			compact.exec("PRAGMA journal_mode=DELETE; VACUUM;");
		} finally {
			compact.close();
		}
		copyFileSync(key, resolve(temporary, "oauth-key.json"));
		for (const name of readdirSync(temporary)) chmodSync(resolve(temporary, name), 0o600);
		const completedAt = clock();
		if (sanitizedAt < options.artworkDeleteAt && completedAt >= options.artworkDeleteAt)
			throw Error("Artwork deletion deadline elapsed during backup; rerun to sanitize");
		const destination = resolve(directory, `${completedAt}-${randomUUID()}`);
		renameSync(temporary, destination);
		prune(directory, completedAt, options.artworkDeleteAt);
		return destination;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		prune(directory, clock(), options.artworkDeleteAt);
		throw error;
	}
}
