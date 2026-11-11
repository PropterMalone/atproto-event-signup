import { describe, expect, it } from "vitest";
import type { SavedResponse } from "../shared/types.js";
import { attendanceDirectory } from "./directory.js";

const audiences = [
	"private",
	"loggedin",
	"public",
	"followers",
	"following",
	"either",
	"mutuals",
] as const;
const expected = [
	[false, true, true, false, false, false, false],
	[false, true, true, true, false, true, false],
	[false, true, true, false, true, true, false],
	[false, true, true, true, true, true, true],
];
const row = (visibility: string, attendance: SavedResponse["attendance"] = "coming") =>
	({
		did: "did:plc:owner",
		handle: "owner.test",
		attendance,
		visibility,
		artwork: { avatar: "secret", handle: "private", style: "pfp", approvedAt: 1 },
		updatedAt: 1,
	}) as SavedResponse;
describe("attendance audience truth table", () => {
	it.each([
		"coming",
		"maybe",
	] as const)("filters %s for every relationship direction", async (attendance) => {
		for (let bits = 0; bits < 4; bits++)
			for (let a = 0; a < audiences.length; a++) {
				const entries = await attendanceDirectory(
					[row(audiences[a]!, attendance)],
					"did:plc:viewer",
					async () => ({ viewerFollowsOwner: !!(bits & 1), ownerFollowsViewer: !!(bits & 2) }),
				);
				expect(entries.entries.length, `${audiences[a]} / ${bits}`).toBe(
					expected[bits]![a] ? 1 : 0,
				);
				if (entries.entries.length)
					expect(entries.entries[0]).toEqual({
						did: "did:plc:owner",
						handle: "owner.test",
						attendance,
					});
			}
	});
	it("batches up to 200 relationship checks in groups of 30 and flags over-budget results", async () => {
		const rows = Array.from({ length: 205 }, (_, index) => ({
			...row("followers"),
			did: `did:plc:${"a".repeat(20)}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(index / 32)]}${"abcdefghijklmnopqrstuvwxyz234567"[index % 32]}aa`,
		}));
		const calls: string[][] = [];
		const result = await attendanceDirectory(
			rows,
			"did:plc:viewer",
			undefined,
			async (_viewer, owners) => {
				calls.push(owners);
				return new Map(
					owners.map((did) => [did, { viewerFollowsOwner: false, ownerFollowsViewer: false }]),
				);
			},
		);
		expect(calls).toHaveLength(7);
		expect(calls.map((batch) => batch.length)).toEqual([30, 30, 30, 30, 30, 30, 20]);
		expect(result).toEqual({ entries: [], incomplete: true });
	});
	it("treats a valid no-follow relationship as complete evidence", async () => {
		const result = await attendanceDirectory(
			[row("followers")],
			"did:plc:viewer",
			undefined,
			async () =>
				new Map([["did:plc:owner", { viewerFollowsOwner: false, ownerFollowsViewer: false }]]),
		);
		expect(result).toEqual({ entries: [], incomplete: false });
	});
	it("shows only public to anonymous visitors, and owners see their own active response", async () => {
		for (const audience of audiences) {
			expect((await attendanceDirectory([row(audience)], null)).entries.length).toBe(
				audience === "public" ? 1 : 0,
			);
			expect((await attendanceDirectory([row(audience)], "did:plc:owner")).entries.length).toBe(1);
		}
	});
	it("excludes unanswered/declined, treats missing or invalid visibility as private, and fails closed", async () => {
		for (const attendance of [null, "cant"] as const)
			expect(
				(await attendanceDirectory([row("public", attendance)], "did:plc:owner")).entries,
			).toEqual([]);
		expect(
			await attendanceDirectory(
				[row("invalid"), row(undefined as unknown as string)],
				"did:plc:viewer",
			),
		).toMatchObject({ entries: [], incomplete: false });
		for (const value of [null, {}, { viewerFollowsOwner: "yes", ownerFollowsViewer: true }]) {
			expect(
				await attendanceDirectory([row("either")], "did:plc:viewer", async () => value as never),
			).toMatchObject({ entries: [], incomplete: true });
		}
		expect(
			await attendanceDirectory([row("followers")], "did:plc:viewer", async () => {
				throw Error("private service error");
			}),
		).toMatchObject({ entries: [], incomplete: true });
	});
});
