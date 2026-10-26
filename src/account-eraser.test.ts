import type { Logger } from "matrix-appservice-bridge";
import { describe, expect, it, vi } from "vitest";

import { createUserDeletedHandler, toSynapseLocalpart } from "./account-eraser";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe("toSynapseLocalpart", () => {
  // Expected values are what Synapse's map_username_to_mxid_localpart returns.
  it.each([
    [
      "John.Doe",
      "john.doe",
    ],
    [
      "user+tag",
      "user+tag",
    ],
    [
      "x/y-z_1",
      "x/y-z_1",
    ],
    [
      "_hidden",
      "=5fhidden",
    ],
    [
      "élodie",
      "=c3=a9lodie",
    ],
    [
      "a=b",
      "a=3db",
    ],
    [
      "Bob O'Neil",
      "bob=20o=27neil",
    ],
  ])("maps %j like Synapse", (username, localpart) => {
    expect(toSynapseLocalpart(username)).toBe(localpart);
  });
});

describe("createUserDeletedHandler", () => {
  const deleted = {
    userId: "User-1790342743145-tn641o",
    internalEmail: "Alice.Martin@acme.example",
    reasonCode: "user_request",
  };

  it("erases the account named after the uid", async () => {
    const eraseAccount = vi.fn(async () => {});

    await createUserDeletedHandler(eraseAccount, "example.com", "uid", log)(deleted);

    expect(eraseAccount).toHaveBeenCalledWith("@user-1790342743145-tn641o:example.com");
  });

  it("erases the account named after the email", async () => {
    const eraseAccount = vi.fn(async () => {});

    await createUserDeletedHandler(eraseAccount, "example.com", "email", log)(deleted);

    expect(eraseAccount).toHaveBeenCalledWith("@alice.martin:example.com");
  });

  it.each([
    [
      "uid",
      {
        internalEmail: "alice@example.com",
      },
    ],
    [
      "email",
      {
        userId: "alice",
      },
    ],
  ] as const)("rejects a message without the %s login, so it is dead-lettered", async (localpartFrom, message) => {
    const eraseAccount = vi.fn(async () => {});

    await expect(createUserDeletedHandler(eraseAccount, "example.com", localpartFrom, log)(message)).rejects.toThrow();
    expect(eraseAccount).not.toHaveBeenCalled();
  });

  it("skips a Matrix ID longer than Synapse allows, since no such account exists", async () => {
    const eraseAccount = vi.fn(async () => {});

    await createUserDeletedHandler(
      eraseAccount,
      "d".repeat(219),
      "email",
      log,
    )({
      internalEmail: `${"a".repeat(35)}@acme.example`,
    });

    expect(eraseAccount).not.toHaveBeenCalled();
  });

  it("refuses an unknown localpartFrom instead of guessing", () => {
    expect(() =>
      createUserDeletedHandler(
        vi.fn(async () => {}),
        "example.com",
        "UID" as unknown as "uid",
        log,
      ),
    ).toThrow('deletion.localpartFrom must be "uid" or "email", got "UID"');
  });

  it("fails when the erasure fails, so the message is retried", async () => {
    const eraseAccount = vi.fn(() => Promise.reject(new Error("Synapse answered 500")));

    await expect(createUserDeletedHandler(eraseAccount, "example.com", "email", log)(deleted)).rejects.toThrow(
      "Synapse answered 500",
    );
  });
});
