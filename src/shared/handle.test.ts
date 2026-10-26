import { expect, it } from "vitest";
import { loginHandle, safeHandle } from "./handle.js";

it.each([
	["alice", "alice.bsky.social"],
	[" @Alice ", "alice.bsky.social"],
	["@Alice.bsky.social", "alice.bsky.social"],
	[" neighbor.example.org ", "neighbor.example.org"],
	["alice.bluesky.social.example", "alice.bluesky.social.example"],
])("normalizes login %s without changing custom domains", (input, handle) => {
	expect(loginHandle(input)).toEqual({ handle });
	expect(safeHandle(handle)).toBe(handle);
});
it("suggests the common suffix typo without silently changing it", () => {
	expect(loginHandle(" @Alice.bluesky.social ")).toEqual({
		error:
			"Did you mean alice.bsky.social? Bluesky usernames end in .bsky.social, not .bluesky.social.",
	});
	expect(safeHandle("alice.bluesky.social")).toBe("alice.bluesky.social");
});
it.each([
	"",
	"@@alice",
	"a b",
	"alice password",
	"did:plc:alice",
	"https://bsky.app/profile/alice",
	"alice/secret",
	"alice@example.org",
	"-alice",
	"alice..test",
	"alice.123",
	"a".repeat(64),
	`${"a".repeat(64)}.test`,
	`${"a.".repeat(124)}example.org`,
])("rejects invalid login %s", (input) => {
	expect(loginHandle(input)).toHaveProperty("error");
});
it.each([
	null,
	undefined,
	5,
	{},
	"a".repeat(513),
])("rejects missing or oversized input", (input) => {
	expect(loginHandle(input)).toHaveProperty("error");
});
it("keeps SDK profile validation strict rather than adding a login suffix", () => {
	expect(safeHandle("alice")).toBeNull();
});
