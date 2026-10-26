// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientState } from "../shared/types.js";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	vi.resetModules();
});
async function page() {
	const html = await readFile("public/index.html", "utf8");
	document.body.innerHTML = html.split("<body>")[1]?.split("</body>")[0] ?? "";
}
const tick = async () => {
	await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(""));
};
it("renders signed-out event copy without collecting a response or showing operator data", async () => {
	await page();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						profile: null,
						csrf: "",
						response: null,
						admin: false,
						policy: { responseCutoff: null, buttonCutoff: null, artworkDeleteAt: null },
					}),
				),
		),
	);
	await import("./main.js");
	await tick();
	expect(document.getElementById("signed-out")?.hidden).toBe(false);
	expect(document.getElementById("signed-in")?.hidden).toBe(true);
	expect(document.getElementById("operator")?.hidden).toBe(true);
	expect(document.body.textContent).toContain("November 10");
	expect(document.body.textContent).toContain("2026");
	expect(document.querySelector('[name="partySize"]')).toBeNull();
	expect(document.querySelector('input[type="email"]')).toBeNull();
	expect((document.getElementById("future-meetups") as HTMLInputElement).checked).toBe(false);
	expect(document.getElementById("policy")?.hidden).toBe(true);
	expect(document.querySelector("details")?.open).toBe(false);
	expect(document.body.textContent).not.toContain("not selected");
	expect(document.body.textContent).not.toContain("Local implementation draft");
});
it("previews saved consent snapshot, permits PFP-only, and decline unchecks button opt-in", async () => {
	await page();
	const state: ClientState = {
		profile: { did: "did:plc:test", handle: "current.test", avatar: "data:image/png;base64,AA==" },
		csrf: "secret",
		responseVersion: "version-a",
		futureMeetups: false,
		preview: { profile: "current-image", saved: "approved-image" },
		response: {
			did: "did:plc:test",
			handle: "current.test",
			attendance: "maybe",
			updatedAt: 1,
			artwork: {
				avatar: "data:image/png;base64,AQ==",
				handle: "approved.test",
				style: "handle",
				approvedAt: 1,
			},
		},
		admin: false,
		policy: { responseCutoff: null, buttonCutoff: null, artworkDeleteAt: null },
	};
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	let conflict = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_path, init) => {
			if (init?.method === "PUT" || init?.method === "DELETE") {
				calls.push({ method: init.method, body: JSON.parse(init.body) });
				if (conflict)
					return new Response(
						JSON.stringify({ error: "Response changed. Reload and preview again." }),
						{ status: 409 },
					);
				if (init.method === "DELETE") {
					state.response = null;
					state.responseVersion = "deleted-version";
				}
				return new Response("{}");
			}
			return new Response(JSON.stringify(state));
		}),
	);
	vi.stubGlobal("confirm", () => true);
	await import("./main.js");
	await tick();
	expect(document.querySelector("#preview image")?.getAttribute("href")).toBe(
		state.response?.artwork?.avatar,
	);
	expect(document.querySelector("#preview textPath")?.textContent).toBe("@approved.test");
	expect(document.getElementById("replacement-option")?.hidden).toBe(false);
	const position = document.getElementById("text-position") as HTMLSelectElement;
	expect(position.value).toBe("bottom");
	expect([...position.options].map((option) => option.value)).toEqual(["bottom", "top"]);
	position.value = "top";
	position.dispatchEvent(new Event("change", { bubbles: true }));
	expect(document.querySelector("#preview path")?.getAttribute("d")).toContain("0 0 1");
	const select = document.getElementById("style") as HTMLSelectElement;
	select.value = "pfp";
	select.dispatchEvent(new Event("change", { bubbles: true }));
	expect(document.querySelector("#preview textPath")).toBeNull();
	expect(document.getElementById("position-option")?.hidden).toBe(true);
	const form = document.getElementById("response") as HTMLFormElement;
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.body).toMatchObject({
		expectedVersion: "version-a",
		artworkSource: "approved-image",
		button: "pfp",
	});
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("Signup saved"),
	);
	conflict = true;
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("Reload and preview"),
	);
	expect(calls).toHaveLength(2);
	conflict = false;
	(document.getElementById("cancel") as HTMLButtonElement).click();
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("deleted"),
	);
	expect(calls[2]).toMatchObject({ method: "DELETE", body: { expectedVersion: "version-a" } });
	expect((document.getElementById("button-opt-in") as HTMLInputElement).checked).toBe(false);
	expect(document.querySelector<HTMLInputElement>('input[name="attendance"]:checked')?.value).toBe(
		"",
	);
	const decline = document.querySelector<HTMLInputElement>('[value="cant"]');
	if (!decline) throw Error("missing");
	decline.click();
	decline.dispatchEvent(new Event("change", { bubbles: true }));
	expect((document.getElementById("button-opt-in") as HTMLInputElement).checked).toBe(false);
	expect(document.getElementById("preview")?.hidden).toBe(true);
	expect(document.getElementById("button-design")?.hidden).toBe(true);
	expect(document.getElementById("replacement-option")?.hidden).toBe(true);
});
it("renders and filters the private operator future-contact list without treating it as attendance", async () => {
	await page();
	const state: ClientState = {
		profile: { did: "did:plc:operator", handle: "operator.test", avatar: null },
		csrf: "secret",
		responseVersion: "0",
		futureMeetups: false,
		preview: { profile: "", saved: null },
		response: null,
		admin: true,
		policy: { responseCutoff: null, buttonCutoff: null, artworkDeleteAt: null },
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (path) =>
				new Response(
					JSON.stringify(
						path === "/api/admin"
							? {
									counts: { coming: 0, maybe: 0, cant: 0, buttons: 0, futureMeetups: 2 },
									responses: [],
								}
							: path === "/api/admin/futurecontacts"
								? {
										contacts: [
											{ did: "did:plc:alice", handle: "alice.test", optedAt: 100 },
											{ did: "did:plc:bob", handle: "bob.test", optedAt: 200 },
										],
									}
								: state,
					),
				),
		),
	);
	await import("./main.js");
	await tick();
	expect(document.getElementById("counts")?.textContent).toContain("Future meetups: 2");
	expect(document.getElementById("contact-count")?.textContent).toBe("2 of 2 contacts");
	const filter = document.getElementById("contact-filter") as HTMLInputElement;
	filter.value = "DID:PLC:BOB";
	filter.dispatchEvent(new Event("input"));
	expect(document.getElementById("contact-count")?.textContent).toBe("1 of 2 contacts");
	expect(document.getElementById("future-contacts")?.textContent).toContain("bob.test");
	expect(document.getElementById("future-contacts")?.textContent).not.toContain("alice.test");
});
it("saves, reloads and unsubscribes future contacts without changing event choices after cutoff", async () => {
	await page();
	const state: ClientState = {
		profile: { did: "did:plc:test", handle: "current.test", avatar: null },
		csrf: "secret",
		responseVersion: "v1",
		futureMeetups: false,
		preview: { profile: "image", saved: null },
		response: null,
		admin: false,
		policy: { responseCutoff: 1, buttonCutoff: 1, artworkDeleteAt: 1 },
	};
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path, init) => {
			if (init?.method === "PUT") {
				const body = JSON.parse(init.body);
				calls.push({ path, body });
				state.futureMeetups = body.futureMeetups;
				state.responseVersion += "x";
				return new Response("{}");
			}
			return new Response(JSON.stringify(state));
		}),
	);
	await import("./main.js");
	await tick();
	const checkbox = document.getElementById("future-meetups") as HTMLInputElement;
	const form = document.getElementById("response") as HTMLFormElement;
	expect(checkbox.checked).toBe(false);
	for (const enabled of [true, false]) {
		checkbox.checked = enabled;
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await vi.waitFor(() => expect(state.futureMeetups).toBe(enabled));
		await vi.waitFor(() =>
			expect(document.getElementById("status")?.textContent).toContain("Signup saved"),
		);
		expect(checkbox.checked).toBe(enabled);
		expect(state.response).toBeNull();
	}
	expect(calls.map((call) => call.path)).toEqual(["/api/preferences", "/api/preferences"]);
	expect(calls[0]?.body).toEqual({ futureMeetups: true, expectedVersion: "v1" });
	expect(calls[1]?.body).toEqual({ futureMeetups: false, expectedVersion: "v1x" });
});
