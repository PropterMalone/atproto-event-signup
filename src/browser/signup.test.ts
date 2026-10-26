// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientState } from "../shared/types.js";

const empty = (): ClientState => ({
	profile: { did: "did:plc:synthetic", handle: "neighbor.test", avatar: null },
	csrf: "test",
	responseVersion: "0",
	response: null,
	futureMeetups: false,
	preview: { profile: "synthetic-profile", saved: null },
	admin: false,
	policy: { responseCutoff: null, buttonCutoff: null, artworkDeleteAt: null },
});
async function page(state: ClientState, fetcher?: typeof fetch) {
	const html = await readFile("public/index.html", "utf8");
	document.body.innerHTML = html.split("<body>")[1]?.split("</body>")[0] ?? "";
	vi.stubGlobal("fetch", fetcher ?? vi.fn(async () => new Response(JSON.stringify(state))));
	await import("./main.js");
	await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(""));
}
const summary = () => document.getElementById("saved-summary") as HTMLElement;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.resetModules();
	document.body.replaceChildren();
});
it.each([
	[" @Alice ", "alice.bsky.social"],
	["@alice.bsky.social", "alice.bsky.social"],
	["friend.custom.example", "friend.custom.example"],
])("submits a normalized handle for %s without changing the input on blur", async (input, expected) => {
	const state = empty();
	state.profile = null;
	const fetcher = vi.fn(async (_path, init) =>
		init?.method === "POST"
			? new Response(JSON.stringify({ error: "Synthetic stop before navigation" }), { status: 400 })
			: new Response(JSON.stringify(state)),
	);
	await page(state, fetcher);
	const field = document.getElementById("handle") as HTMLInputElement;
	field.value = input;
	field.dispatchEvent(new Event("input"));
	field.dispatchEvent(new Event("blur"));
	expect(field.value).toBe(input);
	document.getElementById("login")?.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
	expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({ handle: expected });
});
it("shows a suffix suggestion without a request or silent rewrite", async () => {
	const state = empty();
	state.profile = null;
	const fetcher = vi.fn(async () => new Response(JSON.stringify(state)));
	await page(state, fetcher);
	const field = document.getElementById("handle") as HTMLInputElement;
	field.value = "alice.bluesky.social";
	document.getElementById("login")?.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain(
			"Did you mean alice.bsky.social?",
		),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(field.value).toBe("alice.bluesky.social");
});
it("does not call a login-only account signed up", async () => {
	await page(empty());
	expect(summary().hidden).toBe(true);
});
it.each([
	["coming", true, true, "You’re signed up", "Coming"],
	["maybe", false, false, "Your response is saved", "Maybe"],
	["cant", false, true, "Your response is saved", "Not this time"],
	[null, false, true, "You’re on the list for future meetups", "Attendance: Not answered"],
	[null, true, false, "Your button request is saved", "Attendance: Not answered"],
] as const)("renders persisted choices honestly: %s / button %s / future %s", async (attendance, button, future, title, detail) => {
	const state = empty();
	state.futureMeetups = future;
	if (attendance || button)
		state.response = {
			did: "did:plc:synthetic",
			handle: "neighbor.test",
			attendance,
			artwork: button
				? {
						avatar: "data:image/png;base64,AA==",
						handle: "neighbor.test",
						style: "pfp",
						approvedAt: 1,
					}
				: null,
			updatedAt: 1,
		};
	await page(state);
	expect(summary().hidden).toBe(false);
	expect(summary().textContent).toContain(title);
	expect(summary().textContent).toContain(detail);
	expect(summary().textContent).toContain(button ? "Button: Requested" : "Button: Not requested");
	expect(summary().textContent).toContain(
		future ? "Future meetups: On the list" : "Future meetups: Not on the list",
	);
	expect(summary().textContent).toContain("You can change your choices below.");
	expect(summary().getAttribute("aria-live")).toBe("polite");
});
it("updates after save, survives reload, and clears after opt-out or deletion", async () => {
	const state = empty();
	const fetcher = vi.fn(async (_path, init) => {
		if (init?.method === "PUT") {
			state.futureMeetups = JSON.parse(init.body as string).futureMeetups;
			return new Response("{}");
		}
		if (init?.method === "DELETE") {
			state.futureMeetups = false;
			state.response = null;
			return new Response("{}");
		}
		return new Response(JSON.stringify(state));
	});
	await page(state, fetcher);
	const save = async (enabled: boolean) => {
		(document.getElementById("future-meetups") as HTMLInputElement).checked = enabled;
		document.getElementById("response")?.dispatchEvent(new Event("submit", { cancelable: true }));
		await vi.waitFor(() => expect(summary().hidden).toBe(!enabled));
	};
	await save(true);
	vi.resetModules();
	await page(state, fetcher);
	expect(summary().textContent).toContain("You’re on the list for future meetups");
	await save(false);
	await save(true);
	vi.stubGlobal("confirm", () => true);
	document.getElementById("cancel")?.click();
	await vi.waitFor(() => expect(summary().hidden).toBe(true));
});
