import { resolve } from "node:path";
import { createSnapshot } from "../dist/server/backup.js";
import { readPolicyConfig } from "../dist/server/config.js";

process.umask(0o077);
const { artworkDeleteAt } = readPolicyConfig(process.env);
if (artworkDeleteAt === null) throw Error("Backup requires an explicit ARTWORK_DELETE_AT");
const path = await createSnapshot({
	dataDirectory: resolve(process.env.DATA_DIR ?? ".data"),
	backupDirectory: resolve(process.env.BACKUP_DIR ?? ".backups"),
	artworkDeleteAt,
	...(process.env.PUBLIC_DIR ? { publicDirectory: resolve(process.env.PUBLIC_DIR) } : {}),
});
console.log(`Private snapshot saved: ${path}`);
