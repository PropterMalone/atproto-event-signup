import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { OAuthResolverError } from "@atproto/oauth-client-node";
import {
	BUTTON_FACE_MM,
	BUTTON_LABEL_GUIDANCE,
	BUTTON_RENDERER_VERSION,
	buttonApproval,
	defaultButtonLabel,
	normalizeButtonLabel,
} from "../shared/button.js";
import { loginHandle } from "../shared/handle.js";
import type { ClientState } from "../shared/types.js";
import type { OAuthBoundary } from "./oauth.js";
import { parseResponse } from "./policy.js";
import { printSheet } from "./print.js";
import {
	artworkSource,
	proxyFromEnvironment,
	requestIdentity,
	type TrustedProxy,
} from "./request-identity.js";
import type { Store } from "./store.js";
export interface AppConfig {
	origin: string;
	adminDids: Set<string>;
	responseCutoff: number | null;
	buttonCutoff: number | null;
	artworkDeleteAt: number | null;
	printFaceDiameter?: number;
	printCutDiameter?: number | null;
	publicDirectory: string;
	trustedProxy?: TrustedProxy;
}
function cookie(req: IncomingMessage, name: string): string {
	return (
		req.headers.cookie
			?.split(";")
			.map((p) => p.trim())
			.find((p) => p.startsWith(`${name}=`))
			?.slice(name.length + 1) ?? ""
	);
}
class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
	if (req.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new RequestError(415, "Expected JSON");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 4096) throw new RequestError(413, "Request too large");
		chunks.push(Buffer.from(chunk));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RequestError(400, "Invalid JSON");
	}
}
export function createApp(db: Store, oauth: OAuthBoundary, config: AppConfig) {
	const environmentProxy = proxyFromEnvironment();
	const limits = new Map<string, { count: number; expires: number }>();
	function rate(identity: string, lane: string, maximum: number) {
		const now = Date.now();
		for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
		const key = `${identity}:${lane}`;
		let item = limits.get(key);
		if (!item) {
			if (limits.size > 10000) throw new RequestError(429, "Try again later");
			item = { count: 0, expires: now + 60000 };
			limits.set(key, item);
		}
		if (++item.count > maximum) throw new RequestError(429, "Try again in a minute");
	}
	return async (req: IncomingMessage, res: ServerResponse) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		);
		if (config.origin.startsWith("https:"))
			res.setHeader("Strict-Transport-Security", "max-age=31536000");
		const send = (status: number, body: unknown, type = "application/json; charset=utf-8") => {
			res.statusCode = status;
			res.setHeader("Content-Type", type);
			res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
		};
		const setCookie = (name: string, value: string, age: number) =>
			`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.origin.startsWith("https:") ? "; Secure" : ""}`;
		const redirect = (url: string) => {
			res.statusCode = 303;
			res.setHeader("Location", url);
			res.end();
		};
		try {
			if ((req.url?.length ?? 0) > 4096) throw new RequestError(414, "URL too long");
			const url = new URL(req.url ?? "/", config.origin);
			const method = req.method ?? "GET";
			const now = Date.now();
			db.purge(now, config.artworkDeleteAt);
			const peer = requestIdentity(req, config.trustedProxy ?? environmentProxy);
			if (!["GET", "HEAD"].includes(method) && req.headers.origin !== config.origin)
				throw new RequestError(403, "Origin rejected");
			const token = cookie(req, "dcbsky_session");
			const session = db.session(token, now);
			if (url.pathname === "/health" && method === "GET") return send(200, { ok: true });
			if (url.pathname === "/client-metadata.json" && method === "GET")
				return send(200, oauth.metadata);
			if (url.pathname === "/jwks.json" && method === "GET") return send(200, oauth.jwks);
			if (url.pathname === "/oauth/login" && method === "POST") {
				rate(peer, "login", 10);
				const body = await jsonBody(req);
				const input = loginHandle(
					body && typeof body === "object" && "handle" in body ? body.handle : null,
				);
				if ("error" in input) throw new RequestError(400, input.error);
				const binding = randomBytes(32).toString("base64url");
				let target: URL;
				try {
					target = await oauth.authorize(input.handle, binding);
				} catch (error) {
					// Only the SDK's known missing-handle result is a spelling error, not every resolver failure.
					const cause = error instanceof OAuthResolverError ? error.cause : error;
					if (
						cause instanceof Error &&
						cause.name === "IdentityResolverError" &&
						cause.message === `Handle "${input.handle}" does not resolve to a DID`
					) {
						throw new RequestError(
							400,
							"Couldn’t find that Bluesky handle. Check the spelling and try again.",
						);
					}
					throw error;
				}
				await db.oauthStore<{ pending: true }>("binding", 600000).set(binding, { pending: true });
				res.setHeader("Set-Cookie", setCookie("dcbsky_login", binding, 600));
				if (req.headers.accept === "application/json") return send(200, { url: target.toString() });
				return redirect(target.toString());
			}
			if (url.pathname === "/oauth/callback" && method === "GET") {
				rate(peer, "callback", 20);
				const binding = cookie(req, "dcbsky_login");
				const store = db.oauthStore<{ pending: true }>("binding", 600000);
				if (!binding || !(await store.get(binding)))
					throw new RequestError(400, "Login expired or browser mismatch. Start sign-in again.");
				await store.del(binding);
				try {
					const result = await oauth.complete(url.searchParams);
					if (result.binding !== binding) throw new Error("binding mismatch");
					if (token) db.deleteSession(token);
					const fresh = db.createSession(result.profile, now);
					res.setHeader("Set-Cookie", [
						setCookie("dcbsky_session", fresh, 86400),
						setCookie("dcbsky_login", "", 0),
					]);
					return redirect("/");
				} catch {
					throw new RequestError(400, "Sign-in could not be completed. Start sign-in again.");
				}
			}
			if (url.pathname === "/api/me" && method === "GET") {
				const response = session ? db.get(session.profile.did) : null;
				const state: ClientState = {
					profile: session?.profile ?? null,
					csrf: session?.csrf ?? "",
					response,
					responseVersion: session ? db.version(session.profile.did) : "",
					futureMeetups: !!session && !!db.preference(session.profile.did),
					preview: {
						profile: session ? artworkSource(session.profile) : "",
						saved: response?.artwork ? artworkSource(response.artwork) : null,
					},
					admin: !!session && config.adminDids.has(session.profile.did),
					policy: {
						responseCutoff: config.responseCutoff,
						buttonCutoff: config.buttonCutoff,
						artworkDeleteAt: config.artworkDeleteAt,
					},
				};
				return send(200, state);
			}
			if (url.pathname.startsWith("/api/")) {
				if (!session) throw new RequestError(401, "Sign in with Bluesky first");
				if (method !== "GET" && req.headers["x-csrf-token"] !== session.csrf)
					throw new RequestError(403, "Refresh the page and try again");
				if (url.pathname.startsWith("/api/admin")) {
					if (!config.adminDids.has(session.profile.did))
						throw new RequestError(403, "Operator access required");
					if (url.pathname === "/api/admin" && method === "GET")
						return send(200, {
							counts: db.counts(),
							responses: db.list().map(({ artwork, ...row }) => ({
								...row,
								button: artwork?.style ?? null,
								approvedAt: artwork?.approvedAt ?? null,
							})),
						});
					if (url.pathname === "/api/admin/futurecontacts" && method === "GET") {
						const contacts = db.futureContacts();
						return send(200, { count: contacts.length, contacts });
					}
					if (url.pathname === "/api/admin/print" && method === "GET") {
						if (config.printCutDiameter == null)
							throw new RequestError(
								409,
								"Set PRINT_CUT_DIAMETER_MM explicitly and test it against your actual cutter and press before exporting.",
							);
						res.setHeader("Content-Disposition", 'attachment; filename="dcbsky-home-print.html"');
						return send(
							200,
							printSheet(
								db.eligible(),
								config.printFaceDiameter ?? BUTTON_FACE_MM,
								config.printCutDiameter,
								now,
							),
							"text/html; charset=utf-8",
						);
					}
				}
				if (url.pathname === "/api/logout" && method === "POST") {
					db.deleteSession(token);
					res.setHeader("Set-Cookie", setCookie("dcbsky_session", "", 0));
					return send(200, { ok: true });
				}
				const conflict = () =>
					new RequestError(
						409,
						"Response or preview changed. Reload the page and preview again before saving.",
					);
				if (url.pathname === "/api/preferences" && method === "PUT") {
					const body = await jsonBody(req);
					if (!body || typeof body !== "object" || Array.isArray(body))
						throw new RequestError(400, "Invalid preference fields");
					const fields = body as Record<string, unknown>;
					if (
						Object.keys(fields).some(
							(key) => !["expectedVersion", "futureMeetups"].includes(key),
						) ||
						typeof fields.futureMeetups !== "boolean" ||
						typeof fields.expectedVersion !== "string" ||
						fields.expectedVersion.length > 64
					)
						throw new RequestError(400, "Invalid preference fields");
					if (!db.setPreference(session.profile, fields.futureMeetups, now, fields.expectedVersion))
						throw conflict();
					return send(200, { ok: true });
				}
				if (["/api/response", "/api/signup"].includes(url.pathname) && method === "DELETE") {
					const body = await jsonBody(req);
					if (
						!body ||
						typeof body !== "object" ||
						!("expectedVersion" in body) ||
						typeof body.expectedVersion !== "string"
					)
						throw new RequestError(400, "Expected response version");
					if (!db.cancel(session.profile.did, body.expectedVersion, url.pathname === "/api/signup"))
						throw conflict();
					return send(200, { ok: true });
				}
				if (url.pathname === "/api/response" && method === "PUT") {
					const body = await jsonBody(req);
					if (!body || typeof body !== "object" || Array.isArray(body))
						throw new RequestError(400, "Invalid response fields");
					const {
						expectedVersion,
						artworkSource: approvedSource,
						artworkApproval: approvedArtwork,
						...fields
					} = body as Record<string, unknown>;
					const input = parseResponse(fields);
					if (!input || typeof expectedVersion !== "string" || expectedVersion.length > 64)
						throw new RequestError(400, "Invalid response fields");
					if (db.version(session.profile.did) !== expectedVersion) throw conflict();
					const old = db.get(session.profile.did);
					if (input.button && input.attendance !== "cant") {
						const source = old?.artwork && !input.replaceArtwork ? old.artwork : session.profile;
						if (approvedSource !== artworkSource(source)) throw conflict();
						const label =
							input.label ??
							old?.artwork?.label ??
							defaultButtonLabel(old?.artwork?.handle ?? source.handle);
						if (input.button === "handle" && !normalizeButtonLabel(label))
							throw new RequestError(400, BUTTON_LABEL_GUIDANCE);
						const position = input.position ?? old?.artwork?.position ?? "bottom";
						const color = input.color ?? old?.artwork?.color ?? "white";
						if (
							approvedArtwork !==
							buttonApproval(artworkSource(source), input.button, label, position, color)
						)
							throw conflict();
						if (
							input.label !== undefined ||
							input.position !== undefined ||
							input.color !== undefined ||
							!old?.artwork ||
							input.replaceArtwork ||
							old.artwork.style !== input.button
						)
							input.label = label;
						// Withdrawal stays available even after this session exhausts its save quota.
						rate(session.csrf, "save", 30);
					} else if (input.attendance !== "cant" && old?.attendance !== input.attendance) {
						rate(session.csrf, "save", 30);
					}
					if (
						input.attendance !== "cant" &&
						config.responseCutoff !== null &&
						now >= config.responseCutoff &&
						input.attendance !== (old?.attendance ?? null)
					)
						throw new RequestError(
							409,
							"Attendance changes are closed; you can still decline or delete your response",
						);
					const changedButton =
						!!input.button &&
						input.attendance !== "cant" &&
						(!old?.artwork ||
							old.artwork.style !== input.button ||
							input.replaceArtwork ||
							(input.label !== undefined &&
								(old.artwork.label !== input.label ||
									old.artwork.rendererVersion !== BUTTON_RENDERER_VERSION)) ||
							(input.position !== undefined &&
								((old.artwork.position ?? "bottom") !== input.position ||
									old.artwork.rendererVersion !== BUTTON_RENDERER_VERSION)) ||
							(input.color !== undefined &&
								((old.artwork.color ?? "white") !== input.color ||
									old.artwork.rendererVersion !== BUTTON_RENDERER_VERSION)));
					if (
						changedButton &&
						((config.buttonCutoff !== null && now >= config.buttonCutoff) ||
							(config.artworkDeleteAt !== null && now >= config.artworkDeleteAt))
					)
						throw new RequestError(
							409,
							"Button requests are closed; opt-out and deletion remain available",
						);
					if (changedButton && (!old?.artwork || input.replaceArtwork) && !session.profile.avatar)
						throw new RequestError(
							409,
							"No supported profile image is available. You can save attendance without a button.",
						);
					const saved = db.save(session.profile, input, now, expectedVersion);
					if (!saved) throw conflict();
					return send(200, saved);
				}
			}
			const publicAssets: Record<string, { file: string; type: string }> = {
				"/": { file: "index.html", type: "text/html; charset=utf-8" },
				"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
				"/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
				"/happy-hour.ics": { file: "happy-hour.ics", type: "text/calendar; charset=utf-8" },
				"/social-preview.png": { file: "social-preview.png", type: "image/png" },
				"/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
				"/favicon-32.png": { file: "favicon-32.png", type: "image/png" },
				"/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
				"/icon-192.png": { file: "icon-192.png", type: "image/png" },
				"/icon-512.png": { file: "icon-512.png", type: "image/png" },
				"/site.webmanifest": {
					file: "site.webmanifest",
					type: "application/manifest+json; charset=utf-8",
				},
			};
			const asset = publicAssets[url.pathname];
			if (method === "GET" && asset) {
				const content = await readFile(join(config.publicDirectory, asset.file));
				return send(200, content, asset.type);
			}
			return send(404, { error: "Not found" });
		} catch (error) {
			if (error instanceof RequestError) return send(error.status, { error: error.message });
			return send(503, { error: "Service temporarily unavailable. Try again." });
		}
	};
}
