import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	JoseKey,
	NodeOAuthClient,
	type NodeSavedSession,
	type NodeSavedState,
} from "@atproto/oauth-client-node";
import type { Profile } from "../shared/types.js";
import { avatarSnapshot, boundedBytes, createSdkFetch, safeFetch } from "./network.js";
import { safeHandle } from "./policy.js";
import {
	type PublicationResult,
	type PublicRsvp,
	RSVP_COLLECTION,
	RSVP_SCOPE,
} from "./publication.js";
import type { Store } from "./store.js";
export interface OAuthBoundary {
	metadata: unknown;
	jwks: unknown;
	authorize(handle: string, binding: string, publicAttendance?: boolean): Promise<URL>;
	rsvp?(did: string, rkey: string, record: PublicRsvp | null): Promise<PublicationResult>;
	complete(params: URLSearchParams): Promise<{ profile: Profile; binding: string | null }>;
}
export async function createOAuth(
	origin: string,
	directory: string,
	db: Store,
	publicAttendance = false,
): Promise<OAuthBoundary> {
	const availableScope = publicAttendance ? `atproto ${RSVP_SCOPE}` : "atproto";
	const local = origin.startsWith("http:");
	const path = join(directory, "oauth-key.json");
	let key: JoseKey;
	try {
		key = await JoseKey.fromImportable(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		key = await JoseKey.generate(["ES256"], "dcbsky-1");
		await writeFile(path, JSON.stringify(key.privateJwk), { flag: "wx", mode: 0o600 });
	}
	const redirect = `${origin}/oauth/callback`;
	const sdkLocks = new Set<string>();
	const client = new NodeOAuthClient({
		requestLock: async (name, action) => {
			if (sdkLocks.has(name)) throw new Error("OAuth session is busy; retry shortly");
			sdkLocks.add(name);
			try {
				return await action();
			} finally {
				sdkLocks.delete(name);
			}
		},
		clientMetadata: {
			client_id: local
				? `http://localhost?redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(availableScope)}`
				: `${origin}/client-metadata.json`,
			client_name: "DC Bluesky happy hour",
			...(local ? {} : { client_uri: origin }),
			application_type: "web",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			redirect_uris: [redirect],
			scope: availableScope,
			dpop_bound_access_tokens: true,
			...(local
				? { token_endpoint_auth_method: "none" as const }
				: {
						token_endpoint_auth_method: "private_key_jwt" as const,
						token_endpoint_auth_signing_alg: "ES256" as const,
						jwks_uri: `${origin}/jwks.json`,
					}),
		},
		...(local ? {} : { keyset: [key] }),
		fetch: createSdkFetch(),
		stateStore: db.oauthStore<NodeSavedState>("state", 600000),
		sessionStore: db.oauthStore<NodeSavedSession>("tokens", 86400000),
	});
	const publicKey = key.publicJwk as Record<string, unknown> | undefined;
	if (!publicKey) throw new Error("Missing OAuth public key");
	const jwk = Object.fromEntries(
		["kty", "kid", "crv", "x", "y", "alg", "use"]
			.filter((field) => publicKey[field] !== undefined)
			.map((field) => [field, publicKey[field]]),
	);
	let active = 0;
	async function limited<T>(operation: () => Promise<T>): Promise<T> {
		// Reserve synchronously before the first await; refuse overload, do not queue it.
		if (active >= 4) throw new Error("OAuth is busy; try again shortly");
		active++;
		try {
			return await operation();
		} finally {
			active--;
		}
	}
	return {
		metadata: client.clientMetadata,
		jwks: { keys: [jwk] },
		rsvp: async (did, rkey, record) => {
			try {
				if (!(await db.oauthStore<NodeSavedSession>("tokens", 86400000).get(did)))
					return { ok: false, reason: "reauthorize" };
				const version = db.version(did);
				const session = await client.restore(did);
				const info = await session.getTokenInfo();
				if (session.did !== did || !info.scope.split(" ").includes(RSVP_SCOPE))
					return { ok: false, reason: "reauthorize" };
				const owned = db.publication(did);
				if (!owned || owned.rkey !== rkey) return { ok: false, reason: "conflict" };
				const query = new URLSearchParams({ repo: did, collection: RSVP_COLLECTION, rkey });
				const existing = await session.fetchHandler(`/xrpc/com.atproto.repo.getRecord?${query}`, {
					signal: AbortSignal.timeout(8000),
				});
				let cid: string | null = null;
				if (existing.ok) {
					const bytes = await boundedBytes(existing, 8192);
					if (!bytes) return { ok: false, reason: "uncertain" };
					const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
						cid?: unknown;
						value?: unknown;
					};
					const matches = owned.records.some((known) => {
						const actual = value.value as PublicRsvp | undefined;
						return (
							actual &&
							typeof actual === "object" &&
							!Array.isArray(actual) &&
							Object.keys(actual).length === 3 &&
							actual.subject &&
							typeof actual.subject === "object" &&
							!Array.isArray(actual.subject) &&
							Object.keys(actual.subject).length === 2 &&
							Object.hasOwn(actual.subject, "uri") &&
							Object.hasOwn(actual.subject, "cid") &&
							actual.$type === known.$type &&
							actual.status === known.status &&
							actual.subject?.uri === known.subject.uri &&
							actual.subject?.cid === known.subject.cid
						);
					});
					if (!matches || typeof value.cid !== "string") return { ok: false, reason: "conflict" };
					cid = value.cid;
				} else {
					const bytes = await boundedBytes(
						new Response(existing.body, { headers: existing.headers }),
						4096,
					);
					const error = bytes
						? (JSON.parse(Buffer.from(bytes).toString("utf8")) as { error?: string })
						: null;
					if (error?.error !== "RecordNotFound")
						return { ok: false, reason: existing.status === 401 ? "reauthorize" : "uncertain" };
				}
				if (db.version(did) !== version) return { ok: false, reason: "conflict" };
				if (!record && !cid)
					return owned.unresolvedPut ? { ok: false, reason: "uncertain" } : { ok: true };
				const alreadyUnresolved = !!owned.unresolvedPut;
				if (record) {
					// Persist before dispatch: aborting the client request cannot cancel a PDS commit.
					owned.unresolvedPut = true;
					db.setPublication(did, owned);
				}
				const result = await session.fetchHandler(
					`/xrpc/com.atproto.repo.${record ? "putRecord" : "deleteRecord"}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						signal: AbortSignal.timeout(8000),
						body: JSON.stringify({
							repo: did,
							collection: RSVP_COLLECTION,
							rkey,
							...(record ? { record, validate: false, swapRecord: cid } : { swapRecord: cid }),
						}),
					},
				);
				if (result.ok && record && !alreadyUnresolved) {
					owned.unresolvedPut = false;
					db.setPublication(did, owned);
				}
				return result.ok
					? { ok: true }
					: {
							ok: false,
							reason: result.status === 401 || result.status === 403 ? "reauthorize" : "uncertain",
						};
			} catch {
				return { ok: false, reason: "uncertain" };
			}
		},
		authorize: (handle, binding, requested = false) =>
			limited(() =>
				client.authorize(handle, {
					scope: requested && publicAttendance ? availableScope : "atproto",
					state: binding,
					signal: AbortSignal.timeout(15000),
				}),
			),
		complete: (params) =>
			limited(async () => {
				const { session, state } = await client.callback(params);
				// The SDK validates the token subject/issuer and resolves identity bidirectionally.
				let handle: string = session.did;
				let avatar: string | null = null;
				try {
					const identity = await client.identityResolver.resolve(session.did, {
						signal: AbortSignal.timeout(5000),
					});
					if (identity.handle && safeHandle(identity.handle)) handle = identity.handle;
				} catch {
					/* DID remains a safe display fallback. */
				}
				try {
					const response = await safeFetch(
						`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(session.did)}`,
						{ redirect: "error", signal: AbortSignal.timeout(5000) },
					);
					const bytes = await boundedBytes(response, 65536);
					if (bytes) {
						const profile: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
						if (
							profile &&
							typeof profile === "object" &&
							"did" in profile &&
							profile.did === session.did &&
							"avatar" in profile &&
							typeof profile.avatar === "string"
						)
							avatar = await avatarSnapshot(profile.avatar);
					}
				} catch {
					/* An unavailable PFP must not prevent attendance responses. */
				}
				// Only explicitly granted RSVP sessions need credentials after identity verification.
				const info = await session.getTokenInfo();
				if (!publicAttendance || !info.scope.split(" ").includes(RSVP_SCOPE))
					await db.oauthStore<NodeSavedSession>("tokens", 86400000).del(session.did);
				return { profile: { did: session.did, handle, avatar }, binding: state };
			}),
	};
}
