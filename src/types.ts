/**
 * AMQP server connection settings.
 */
export interface AmqpConfig {
  readonly host: string;
  readonly port: number;
  readonly vhost: string;
  readonly username: string;
  readonly password: string;
  readonly tls?: boolean;
}

/**
 * Defines the retry strategy for Synapse admin API operations.
 * This controls how the bridge handles failures when attempting to update
 * user profiles via the Synapse admin API.
 */
export enum SynapseAdminRetryMode {
  DISABLED = "disabled",
  FALLBACK = "fallback",
  EXCLUSIVE = "exclusive",
}

/**
 * Represents user profile and settings data that can be synchronized
 * across services via the common-settings bridge.
 */
export interface ISettingsPayload {
  readonly language?: string;
  readonly timezone?: string;
  readonly avatar?: string;
  readonly last_name?: string;
  readonly first_name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly matrix_id: string;
  readonly display_name?: string;
}

/**
 * Represents a complete message exchanged via AMQP for settings synchronization.
 */
export interface CommonSettingsMessage {
  readonly source: string;
  readonly nickname: string;
  readonly request_id: string;
  readonly timestamp: number;
  readonly version: number;
  readonly payload: ISettingsPayload;
}

/**
 * Represents user settings as stored in the bridge database.
 * Named StoredUserSettings to distinguish from the UserSettings type
 * in the @twake/common-settings package.
 */
export interface StoredUserSettings {
  readonly source?: string;
  readonly nickname: string;
  readonly request_id: string;
  readonly timestamp: number;
  readonly version: number;
  readonly payload: ISettingsPayload;
  /** The avatar last uploaded to Matrix. */
  readonly avatar?: AvatarUpload;
}

/** An avatar URL and the mxc URL its upload became. */
export interface AvatarUpload {
  readonly source: string;
  readonly mxc: string;
}

/**
 * Configuration for AMQP exchange, queue, and routing within the bridge.
 * The dead-letter exchange/queue are derived automatically by the client
 * (`<exchange>.dlx`, `<queue>.dlq`, `<routingKey>.dead`). When `routingKey`
 * is omitted, the bridge subscribes with `#` (catch-all topic binding).
 */
export interface BridgeAmqpConfig {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey?: string;
  /** Channel prefetch (in-flight handler concurrency). Lib default: 10. */
  readonly prefetch?: number;
  /** Handler retries before DLQ for transient failures. Lib default: 3. */
  readonly maxRetries?: number;
  /** Delay between handler retries, ms. Lib default: 1000. */
  readonly retryDelay?: number;
}

/**
 * Configuration for the bridge's Postgres database.
 */
export interface DatabaseConfig {
  /** The host, or `host:port`. Defaults to localhost. */
  readonly host?: string;
  readonly name?: string;
  readonly user?: string;
  readonly password?: string;
  readonly ssl?: boolean;
}

/**
 * Configuration specific to Synapse homeserver integration.
 */
export interface SynapseConfig {
  readonly adminRetryMode: "disabled" | "fallback" | "exclusive";
  /** Maximum avatar file size in bytes. Default: 5MB (5242880) */
  readonly avatarMaxSizeBytes?: number;
  /** Timeout for fetching external avatar URLs in milliseconds. Default: 10000 (10s) */
  readonly avatarFetchTimeoutMs?: number;
}

/**
 * Where the bridge consumes user deletions, and how the homeserver's SSO
 * mapping named the accounts: from the directory uid (`userId`) or from the
 * local part of the email (`internalEmail`).
 */
export interface DeletionConfig {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: string;
  readonly localpartFrom: "uid" | "email";
}

/**
 * Where the bridge consumes space events, where it announces each space's
 * Matrix space, and how the homeserver's SSO mapping named the accounts: from
 * the member's `username` or from the local part of their `email`.
 */
export interface SpacesConfig {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: string;
  readonly activityExchange: string;
  readonly localpartFrom: "uid" | "email";
  /** TwakeSpace's app service user, which posts the feed. Default: `@twakespace:<domain>` */
  readonly twakeSpaceUserId?: string;
  /** The directory's space exchange, where the bridge requests a sync while it knows no space. Off when omitted. */
  readonly syncRequestExchange?: string;
  /** The organization the sync request names. Every organization when omitted, for a homeserver they share. */
  readonly organizationId?: string;
}

/**
 * Complete configuration for the common-settings bridge.
 */
export interface BridgeConfig {
  readonly homeserverUrl: string;
  readonly domain: string;
  readonly registrationPath: string;
  readonly synapse: SynapseConfig;
  readonly rabbitmq: AmqpConfig & BridgeAmqpConfig;
  readonly database: DatabaseConfig;
  /** Account erasure on user deletion. Off when omitted. */
  readonly deletion?: DeletionConfig;
  /** Matrix spaces for TwakeSpace spaces. Off when omitted. */
  readonly spaces?: SpacesConfig;
}

// =============================================================================
// Error Classes (merged from errors.ts)
// =============================================================================

/**
 * Error thrown when a user ID (matrix_id) is not provided in the message payload.
 * This occurs when processing AMQP messages that lack the required user identifier
 * needed to perform profile updates.
 */
export class UserIdNotProvidedError extends Error {
  constructor(message = "User ID (matrix_id) not provided in message payload") {
    super(message);
    this.name = "UserIdNotProvidedError";
  }
}

/**
 * Error thrown when parsing an AMQP message payload fails.
 * This can occur due to malformed JSON, unexpected data types,
 * or missing required fields in the message structure.
 */
export class MessageParseError extends Error {
  constructor(message = "Failed to parse AMQP message payload") {
    super(message);
    this.name = "MessageParseError";
  }
}

/**
 * Error thrown when an avatar download fails validation checks.
 * This includes timeout, size limit exceeded, or HTTP errors.
 */
export class AvatarFetchError extends Error {
  constructor(message = "Failed to fetch avatar from external URL") {
    super(message);
    this.name = "AvatarFetchError";
  }
}
