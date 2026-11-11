import type { Relationship, RelationshipLookup } from "./directory.js";

const validDid = (did: string) =>
	/^did:plc:[a-z2-7]{24}$/.test(did) || /^did:web:[A-Za-z0-9._:%-]{1,240}$/.test(did);
const recordUri = (value: unknown, did: string) =>
	typeof value === "string" &&
	value.startsWith(`at://${did}/app.bsky.graph.follow/`) &&
	/^[A-Za-z0-9._~:-]{1,512}$/.test(value.slice(`at://${did}/app.bsky.graph.follow/`.length));

function parseBatch(
	result: unknown,
	viewerDid: string,
	owners: string[],
): Map<string, Relationship> | null {
	if (!result || typeof result !== "object") return null;
	const data = result as { actor?: unknown; relationships?: unknown };
	if (data.actor !== viewerDid || !Array.isArray(data.relationships)) return null;
	const expected = new Set(owners);
	const parsed = new Map<string, Relationship>();
	const seen = new Set<string>();
	for (const rowValue of data.relationships) {
		if (!rowValue || typeof rowValue !== "object") continue;
		const row = rowValue as Record<string, unknown>;
		if (row.$type === "app.bsky.graph.defs#notFoundActor") {
			if (typeof row.actor !== "string" || !expected.has(row.actor) || seen.has(row.actor))
				return null;
			seen.add(row.actor);
			continue;
		}
		if (typeof row.did !== "string" || !expected.has(row.did) || seen.has(row.did)) return null;
		seen.add(row.did);
		if (row.$type !== "app.bsky.graph.defs#relationship") continue;
		// Block fields contain record URIs, not booleans. Any evidence denies this row.
		if (
			["blockedBy", "blocking", "blockingByList", "blockedByList"].some(
				(key) => row[key] !== undefined,
			)
		)
			continue;
		if (row.following !== undefined && !recordUri(row.following, viewerDid)) continue;
		if (row.followedBy !== undefined && !recordUri(row.followedBy, row.did)) continue;
		parsed.set(row.did, {
			viewerFollowsOwner: row.following !== undefined,
			ownerFollowsViewer: row.followedBy !== undefined,
		});
	}
	return parsed;
}

/** Public graph reads only. Each request contains at most 30 DIDs and has no persistent cache. */
export function publicRelationshipBatch(fetcher: typeof fetch = fetch) {
	let active = 0;
	return async (
		viewerDid: string,
		ownerDids: string[],
	): Promise<Map<string, Relationship> | null> => {
		if (
			!validDid(viewerDid) ||
			ownerDids.length < 1 ||
			ownerDids.length > 30 ||
			ownerDids.some((did) => !validDid(did))
		)
			return null;
		if (new Set(ownerDids).size !== ownerDids.length || active >= 4) return null;
		active++;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.graph.getRelationships");
			url.searchParams.set("actor", viewerDid);
			for (const did of ownerDids) url.searchParams.append("others", did);
			const response = await fetcher(url, {
				headers: { accept: "application/json" },
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok || !response.body) return null;
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 65536) {
						await reader.cancel();
						return null;
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
			return parseBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")), viewerDid, ownerDids);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			active--;
		}
	};
}

/** Compatibility adapter for callers needing one relationship. */
export function publicRelationships(fetcher: typeof fetch = fetch): RelationshipLookup {
	const batch = publicRelationshipBatch(fetcher);
	return async (viewerDid, ownerDid) => (await batch(viewerDid, [ownerDid]))?.get(ownerDid) ?? null;
}
