import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BUTTON_RENDERER_VERSION, defaultButtonLabel } from "../shared/button.js";
import type {
	Artwork,
	FutureContact,
	Profile,
	ResponseInput,
	SavedResponse,
	Session,
} from "../shared/types.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export class Store {
	private db: DatabaseSync;
	constructor(readonly path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS responses(did TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS future_contacts(did TEXT PRIMARY KEY, handle TEXT NOT NULL, opted_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS response_versions(subject TEXT PRIMARY KEY, version TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS oauth(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(namespace,key));`);
	}
	close() {
		this.db.close();
	}
	get(did: string): SavedResponse | null {
		const row = this.db.prepare("SELECT value FROM responses WHERE did=?").get(did);
		return row ? (JSON.parse(String(row.value)) as SavedResponse) : null;
	}
	list(): SavedResponse[] {
		return this.db
			.prepare("SELECT value FROM responses ORDER BY did")
			.all()
			.map((row) => JSON.parse(String(row.value)) as SavedResponse);
	}
	eligible(): SavedResponse[] {
		return this.list().filter((row) => row.artwork !== null);
	}
	preference(did: string): FutureContact | null {
		const row = this.db
			.prepare("SELECT did,handle,opted_at AS optedAt FROM future_contacts WHERE did=?")
			.get(did);
		return row
			? { did: String(row.did), handle: String(row.handle), optedAt: Number(row.optedAt) }
			: null;
	}
	futureContacts(): FutureContact[] {
		return this.db
			.prepare("SELECT did,handle,opted_at AS optedAt FROM future_contacts ORDER BY did")
			.all()
			.map((row) => ({
				did: String(row.did),
				handle: String(row.handle),
				optedAt: Number(row.optedAt),
			}));
	}
	private updatePreference(profile: Profile, enabled: boolean, now: number) {
		if (enabled) {
			this.db
				.prepare(
					"INSERT INTO future_contacts VALUES(?,?,?) ON CONFLICT(did) DO UPDATE SET handle=excluded.handle",
				)
				.run(profile.did, profile.handle, now);
		} else {
			this.db.prepare("DELETE FROM future_contacts WHERE did=?").run(profile.did);
		}
	}
	setPreference(profile: Profile, enabled: boolean, now: number, expected: string): boolean {
		return (
			this.write(profile.did, expected, () => {
				this.updatePreference(profile, enabled, now);
				return true;
			}) === true
		);
	}
	counts() {
		const rows = this.list();
		return {
			coming: rows.filter((r) => r.attendance === "coming").length,
			maybe: rows.filter((r) => r.attendance === "maybe").length,
			cant: rows.filter((r) => r.attendance === "cant").length,
			buttons: this.eligible().length,
			futureMeetups: this.futureContacts().length,
		};
	}
	version(did: string): string {
		const row = this.db
			.prepare("SELECT version FROM response_versions WHERE subject=?")
			.get(hash(did));
		return row ? String(row.version) : "0";
	}
	private advance(did: string) {
		this.db
			.prepare(
				"INSERT INTO response_versions VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET version=excluded.version",
			)
			.run(hash(did), randomBytes(24).toString("base64url"));
	}
	private write<T>(did: string, expected: string, action: () => T): T | null {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (this.version(did) !== expected) {
				this.db.exec("ROLLBACK");
				return null;
			}
			const result = action();
			this.advance(did);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	save(
		profile: Profile,
		input: ResponseInput,
		now: number,
		expected: string,
	): SavedResponse | null {
		return this.write(profile.did, expected, () => {
			const old = this.get(profile.did);
			if (input.futureMeetups !== undefined)
				this.updatePreference(profile, input.futureMeetups, now);
			let artwork: Artwork | null = null;
			if (input.button && input.attendance !== "cant") {
				const previous = old?.artwork;
				const preserve =
					previous &&
					!input.replaceArtwork &&
					previous.style === input.button &&
					input.label === undefined &&
					input.position === undefined &&
					input.color === undefined;
				const snapshot =
					previous && !input.replaceArtwork
						? previous
						: { avatar: profile.avatar ?? "", handle: profile.handle };
				const label =
					input.label ?? previous?.label ?? defaultButtonLabel(previous?.handle ?? snapshot.handle);
				const position = input.position ?? previous?.position ?? "bottom";
				const color = input.color ?? previous?.color ?? "white";
				artwork = {
					label,
					position,
					color,
					rendererVersion: BUTTON_RENDERER_VERSION,
					avatar: snapshot.avatar,
					handle: snapshot.handle,
					style: input.button,
					approvedAt:
						previous &&
						!input.replaceArtwork &&
						previous.style === input.button &&
						(previous.label ?? defaultButtonLabel(previous.handle)) === label &&
						previous.rendererVersion === BUTTON_RENDERER_VERSION &&
						(previous.position ?? "bottom") === position &&
						(previous.color ?? "white") === color
							? previous.approvedAt
							: now,
				};
				if (preserve) artwork = previous;
			}
			const saved = {
				did: profile.did,
				handle: profile.handle,
				attendance: input.attendance,
				artwork,
				updatedAt: now,
			};
			this.db
				.prepare(
					"INSERT INTO responses VALUES(?,?) ON CONFLICT(did) DO UPDATE SET value=excluded.value",
				)
				.run(profile.did, JSON.stringify(saved));
			return saved;
		});
	}
	cancel(did: string, expected: string, all = false): boolean {
		return (
			this.write(did, expected, () => {
				this.db.prepare("DELETE FROM responses WHERE did=?").run(did);
				if (all) this.db.prepare("DELETE FROM future_contacts WHERE did=?").run(did);
				return true;
			}) === true
		);
	}
	createSession(profile: Profile, now: number): string {
		const token = randomBytes(32).toString("base64url");
		const expires = now + 86400000;
		const value: Session = { profile, csrf: randomBytes(32).toString("base64url"), expires };
		this.db
			.prepare("INSERT INTO sessions VALUES(?,?,?)")
			.run(hash(token), JSON.stringify(value), expires);
		return token;
	}
	session(token: string, now: number): Session | null {
		const row = this.db
			.prepare("SELECT value FROM sessions WHERE id=? AND expires>?")
			.get(hash(token), now);
		return row ? (JSON.parse(String(row.value)) as Session) : null;
	}
	deleteSession(token: string) {
		this.db.prepare("DELETE FROM sessions WHERE id=?").run(hash(token));
	}
	purge(now: number, artworkDeleteAt: number | null) {
		this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
		this.db.prepare("DELETE FROM oauth WHERE expires<=?").run(now);
		if (artworkDeleteAt !== null && now >= artworkDeleteAt) {
			for (const row of this.eligible()) {
				this.write(row.did, this.version(row.did), () => {
					row.artwork = null;
					this.db
						.prepare("UPDATE responses SET value=? WHERE did=?")
						.run(JSON.stringify(row), row.did);
				});
			}
			// Remove cached profile pictures too, without ending attendance-only sessions.
			for (const session of this.db.prepare("SELECT id,value FROM sessions").all()) {
				const value = JSON.parse(String(session.value)) as Session;
				value.profile.avatar = null;
				this.db
					.prepare("UPDATE sessions SET value=? WHERE id=?")
					.run(JSON.stringify(value), String(session.id));
			}
		}
	}
	oauthStore<T>(namespace: string, ttl: number) {
		return {
			get: async (key: string): Promise<T | undefined> => {
				const row = this.db
					.prepare("SELECT value FROM oauth WHERE namespace=? AND key=? AND expires>?")
					.get(namespace, key, Date.now());
				return row ? (JSON.parse(String(row.value)) as T) : undefined;
			},
			set: async (key: string, value: T) => {
				this.db
					.prepare(
						"INSERT INTO oauth VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
					)
					.run(namespace, key, JSON.stringify(value), Date.now() + ttl);
			},
			del: async (key: string) => {
				this.db.prepare("DELETE FROM oauth WHERE namespace=? AND key=?").run(namespace, key);
			},
		};
	}
}
