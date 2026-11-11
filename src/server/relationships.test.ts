import { expect, it, vi } from "vitest";
import { publicRelationships } from "./relationships.js";

const viewer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const owner = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const body = () => ({
	actor: viewer,
	relationships: [
		{
			$type: "app.bsky.graph.defs#relationship",
			did: owner,
			following: `at://${viewer}/app.bsky.graph.follow/abc`,
			followedBy: `at://${owner}/app.bsky.graph.follow/def`,
		},
	],
});
it("batches up to 30 verified owners in one public read-only request", async () => {
	const owners = [owner, "did:plc:cccccccccccccccccccccccc"];
	const fetcher = vi.fn(
		async (_input: URL | RequestInfo, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					actor: viewer,
					relationships: owners.map((did) => ({ $type: "app.bsky.graph.defs#relationship", did })),
				}),
			),
	);
	const { publicRelationshipBatch } = await import("./relationships.js");
	const result = await publicRelationshipBatch(fetcher)(viewer, owners);
	expect(result?.size).toBe(2);
	expect(result?.get(owners[1]!)).toEqual({ viewerFollowsOwner: false, ownerFollowsViewer: false });
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect((fetcher.mock.calls[0]![0] as URL).searchParams.getAll("others")).toEqual(owners);
});

it("uses a fixed public read-only endpoint and maps both directions without tokens", async () => {
	const fetcher = vi.fn(async () => new Response(JSON.stringify(body())));
	const lookup = publicRelationships(fetcher);
	expect(await lookup(viewer, owner)).toEqual({
		viewerFollowsOwner: true,
		ownerFollowsViewer: true,
	});
	const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
	expect(url.origin).toBe("https://public.api.bsky.app");
	expect(url.searchParams.get("actor")).toBe(viewer);
	expect(url.searchParams.getAll("others")).toEqual([owner]);
	expect(options.redirect).toBe("error");
	expect(options.headers).toEqual({ accept: "application/json" });
});
it("keeps valid relationships when another row is blocked or not found", async () => {
	const other = "did:plc:cccccccccccccccccccccccc";
	const rows = [
		{
			$type: "app.bsky.graph.defs#relationship",
			did: owner,
			following: `at://${viewer}/app.bsky.graph.follow/abc`,
		},
		{
			$type: "app.bsky.graph.defs#relationship",
			did: other,
			blocking: `at://${viewer}/app.bsky.graph.block/blocked`,
		},
	];
	const batch = await (await import("./relationships.js")).publicRelationshipBatch(
		async () => new Response(JSON.stringify({ actor: viewer, relationships: rows })),
	)(viewer, [owner, other]);
	expect(batch?.get(owner)).toEqual({ viewerFollowsOwner: true, ownerFollowsViewer: false });
	expect(batch?.has(other)).toBe(false);
	const partial = await (await import("./relationships.js")).publicRelationshipBatch(
		async () =>
			new Response(
				JSON.stringify({
					actor: viewer,
					relationships: [
						rows[0],
						{ $type: "app.bsky.graph.defs#notFoundActor", actor: other, notFound: true },
					],
				}),
			),
	)(viewer, [owner, other]);
	expect(partial?.get(owner)?.viewerFollowsOwner).toBe(true);
	expect(partial?.has(other)).toBe(false);
});
it("fails closed for absent/wrong identities, invalid types, blocks and foreign follow record owners", async () => {
	const valid = body();
	for (const value of [
		{ relationships: valid.relationships },
		{ ...valid, actor: owner },
		{ ...valid, relationships: [{ ...valid.relationships[0], did: viewer }] },
		{ ...valid, relationships: [{ ...valid.relationships[0], following: true }] },
		{
			...valid,
			relationships: [
				{ ...valid.relationships[0], followedBy: `at://${viewer}/app.bsky.graph.follow/abc` },
			],
		},
		{ ...valid, relationships: [{ ...valid.relationships[0], blockedBy: "invalid" }] },
		{
			...valid,
			relationships: [{ ...valid.relationships[0], $type: "app.bsky.graph.defs#notFoundActor" }],
		},
	]) {
		expect(
			await publicRelationships(async () => new Response(JSON.stringify(value)))(viewer, owner),
		).toBeNull();
	}
});
it("bounds payloads, rejects invalid DIDs before HTTP and does not cache positive results", async () => {
	const fetcher = vi.fn(async () => new Response("x".repeat(17000)));
	const lookup = publicRelationships(fetcher);
	expect(await lookup("http://127.0.0.1", owner)).toBeNull();
	expect(fetcher).not.toHaveBeenCalled();
	expect(await lookup(viewer, owner)).toBeNull();
	let calls = 0;
	const fresh = publicRelationships(
		async () =>
			new Response(
				JSON.stringify(
					calls++
						? {
								actor: viewer,
								relationships: [{ $type: "app.bsky.graph.defs#relationship", did: owner }],
							}
						: body(),
				),
			),
	);
	expect((await fresh(viewer, owner))?.viewerFollowsOwner).toBe(true);
	expect((await fresh(viewer, owner))?.viewerFollowsOwner).toBe(false);
});
