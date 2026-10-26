import type { Logger } from "matrix-appservice-bridge";

import type { DeletionConfig } from "./types.js";

/** Deactivates and erases one Matrix account. */
export type EraseAccount = (matrixId: string) => Promise<void>;

// Synapse's MXID_LOCALPART_ALLOWED_CHARACTERS minus "=", which its mapping escapes
const MXID_LOCALPART_CHARACTER = /^[a-z0-9._/+-]$/;

// Synapse refuses to register a longer user ID, so no such account exists
const MAX_USERID_LENGTH = 255;

/**
 * The localpart Synapse gives an SSO user whose login is `username`, following
 * its `map_username_to_mxid_localpart`: ASCII letters lowercased, any other
 * byte outside the localpart grammar escaped as `=xx`, and a leading `_`
 * escaped too.
 */
export function toSynapseLocalpart(username: string): string {
  let localpart = "";

  for (const byte of new TextEncoder().encode(username.replace(/[A-Z]/g, (c) => c.toLowerCase()))) {
    const character = String.fromCharCode(byte);
    localpart += MXID_LOCALPART_CHARACTER.test(character) ? character : `=${byte.toString(16).padStart(2, "0")}`;
  }

  return localpart.replace(/^_/, "=5f");
}

/**
 * The login the homeserver's SSO mapping built the localpart from: the
 * directory uid, or the local part of the email.
 */
function loginOf(message: Record<string, unknown>, localpartFrom: DeletionConfig["localpartFrom"]): string {
  if (localpartFrom === "uid") {
    const { userId } = message;
    if (typeof userId !== "string" || userId === "") {
      throw new Error("user.deleted: the message has no userId");
    }
    return userId;
  }

  const { internalEmail } = message;
  const at = typeof internalEmail === "string" ? internalEmail.indexOf("@") : -1;
  if (typeof internalEmail !== "string" || at <= 0) {
    throw new Error("user.deleted: the message has no internalEmail");
  }
  return internalEmail.slice(0, at);
}

/**
 * Builds the handler for `user.deleted` messages. A message the bridge cannot
 * map to an account throws, so it ends in the dead-letter queue instead of
 * leaving the account in place without a trace.
 */
export function createUserDeletedHandler(
  eraseAccount: EraseAccount,
  domain: string,
  localpartFrom: DeletionConfig["localpartFrom"],
  log: Logger,
): (message: Record<string, unknown>) => Promise<void> {
  // A wrong mode would erase someone else's account, so an unknown one stops the bridge
  if (localpartFrom !== "uid" && localpartFrom !== "email") {
    throw new Error(`deletion.localpartFrom must be "uid" or "email", got ${JSON.stringify(localpartFrom)}`);
  }

  return async (message: Record<string, unknown>): Promise<void> => {
    const matrixId = `@${toSynapseLocalpart(loginOf(message, localpartFrom))}:${domain}`;
    if (matrixId.length > MAX_USERID_LENGTH) {
      log.warn(`${matrixId} is longer than a Matrix user ID can be, so there is no account to erase`);
      return;
    }
    await eraseAccount(matrixId);
    log.info(`Erased the Matrix account ${matrixId}`);
  };
}
