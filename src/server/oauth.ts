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
import type { Store } from "./store.js";
export interface OAuthBoundary {
	metadata: unknown;
	jwks: unknown;
	authorize(handle: string, binding: string): Promise<URL>;
	complete(params: URLSearchParams): Promise<{ profile: Profile; binding: string | null }>;
}
export async function createOAuth(
	origin: string,
	directory: string,
	db: Store,
): Promise<OAuthBoundary> {
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
	const client = new NodeOAuthClient({
		clientMetadata: {
			client_id: local
				? `http://localhost?redirect_uri=${encodeURIComponent(redirect)}&scope=atproto`
				: `${origin}/client-metadata.json`,
			client_name: "DC Bluesky happy hour",
			...(local ? {} : { client_uri: origin }),
			application_type: "web",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			redirect_uris: [redirect],
			scope: "atproto",
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
		sessionStore: db.oauthStore<NodeSavedSession>("tokens", 600000),
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
		authorize: (handle, binding) =>
			limited(() =>
				client.authorize(handle, {
					scope: "atproto",
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
				// No ongoing API access is needed; discard local access/refresh credentials immediately.
				await db.oauthStore<NodeSavedSession>("tokens", 600000).del(session.did);
				return { profile: { did: session.did, handle, avatar }, binding: state };
			}),
	};
}
