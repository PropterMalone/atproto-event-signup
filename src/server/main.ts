import { chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readAdminDids, readPolicyConfig } from "./config.js";
import { createOAuth } from "./oauth.js";
import { Store } from "./store.js";

process.umask(0o077);
const { origin, responseCutoff, buttonCutoff, artworkDeleteAt } = readPolicyConfig(process.env);
const adminDids = readAdminDids(process.env);
if (process.env.PRINT_DIAMETER_MM)
	throw Error(
		"Replace PRINT_DIAMETER_MM with separate PRINT_FACE_DIAMETER_MM and PRINT_CUT_DIAMETER_MM; verify actual hardware.",
	);
const face = Number(process.env.PRINT_FACE_DIAMETER_MM ?? 58);
const cut = process.env.PRINT_CUT_DIAMETER_MM ? Number(process.env.PRINT_CUT_DIAMETER_MM) : null;
if (
	!Number.isFinite(face) ||
	face < 40 ||
	face > 80 ||
	(cut !== null && (!Number.isFinite(cut) || cut < face || cut > 100))
)
	throw Error("Print face must be 40–80 mm; explicit cut must be between face diameter and 100 mm");
const port = Number(process.env.PORT ?? (new URL(origin).port || 3000));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid PORT");
const directory = resolve(process.env.DATA_DIR ?? ".data");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const db = new Store(resolve(directory, "app.sqlite"));
chmodSync(db.path, 0o600);
const oauth = await createOAuth(origin, directory, db);
const config = {
	origin,
	adminDids,
	responseCutoff,
	buttonCutoff,
	artworkDeleteAt,
	printFaceDiameter: face,
	printCutDiameter: cut,
	publicDirectory: process.env.PUBLIC_DIR
		? resolve(process.env.PUBLIC_DIR)
		: fileURLToPath(new URL("../public/", import.meta.url)),
};
const server = createServer(createApp(db, oauth, config));
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.maxHeadersCount = 50;
const sweep = setInterval(() => db.purge(Date.now(), artworkDeleteAt), 60000);
sweep.unref();
server.listen(port, "127.0.0.1", () =>
	console.log(`DC Bluesky listening on 127.0.0.1:${port}; configured origin ${origin}`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => {
		clearInterval(sweep);
		server.close(() => {
			db.close();
			process.exit(0);
		});
	});
