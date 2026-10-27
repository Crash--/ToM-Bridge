import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { SettingsRepository } from "./settings-repository.js";
import type { ISettingsPayload, UserSettingsTableName } from "./types.js";

// Type-only imports to avoid runtime module resolution issues in tests
type AnyFn = (...args: any[]) => any;
type Database<_T> = {
  get: Mock<AnyFn>;
  upsertIfNewer: Mock<AnyFn>;
  update: Mock<AnyFn>;
  close: Mock<AnyFn>;
};

type Logger = {
  debug: Mock<AnyFn>;
  info: Mock<AnyFn>;
  warn: Mock<AnyFn>;
  error: Mock<AnyFn>;
};

describe("SettingsRepository", () => {
  let repository: SettingsRepository;
  let mockDb: Database<UserSettingsTableName>;
  let mockLogger: Logger;

  const createMockLogger = (): Logger => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  const createMockDatabase = (): Database<UserSettingsTableName> => ({
    get: vi.fn(),
    upsertIfNewer: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
  });

  const createTestPayload = (overrides: Partial<ISettingsPayload> = {}): ISettingsPayload => ({
    matrix_id: "@user:example.com",
    display_name: "Test User",
    avatar: "mxc://example.com/avatar123",
    email: "test@example.com",
    phone: "+1234567890",
    language: "en",
    timezone: "UTC",
    first_name: "Test",
    last_name: "User",
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDatabase();
    mockLogger = createMockLogger();
    repository = new SettingsRepository(mockDb as any, mockLogger as any);
  });

  describe("getUserSettings", () => {
    it("should get existing user settings", async () => {
      const payload = createTestPayload();
      const dbRow = {
        matrix_id: "@user:example.com",
        settings: payload, // jsonb returns as object, not string
        version: 1,
        timestamp: 1234567890,
        request_id: "req-123",
        avatar_source: "https://workspace.example.com/avatar.png",
        avatar_mxc: "mxc://example.com/avatar",
      };

      mockDb.get.mockResolvedValue([
        dbRow,
      ]);

      const result = await repository.getUserSettings("@user:example.com");

      expect(mockDb.get).toHaveBeenCalledWith(
        "usersettings",
        [
          "matrix_id",
          "settings",
          "version",
          "timestamp",
          "request_id",
          "avatar_source",
          "avatar_mxc",
        ],
        {
          matrix_id: "@user:example.com",
        },
      );

      expect(result).toEqual({
        nickname: "@user:example.com",
        payload,
        version: 1,
        timestamp: 1234567890,
        request_id: "req-123",
        avatar: {
          source: "https://workspace.example.com/avatar.png",
          mxc: "mxc://example.com/avatar",
        },
      });

      expect(mockLogger.debug).toHaveBeenCalledWith("Looking up user settings for @user:example.com");
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Found existing settings for @user:example.com"),
      );
    });

    it("should return null when user does not exist", async () => {
      mockDb.get.mockResolvedValue([]);

      const result = await repository.getUserSettings("@nonexistent:example.com");

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith("No existing settings found for @nonexistent:example.com");
    });

    it("should return null when settings JSON is corrupted", async () => {
      const dbRow = {
        matrix_id: "@user:example.com",
        settings: "invalid json {",
        version: 1,
        timestamp: 1234567890,
        request_id: "req-123",
      };

      mockDb.get.mockResolvedValue([
        dbRow,
      ]);

      const result = await repository.getUserSettings("@user:example.com");

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse settings payload from database"),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Settings for @user:example.com in database are corrupted, treating as new user"),
      );
    });

    it("should throw error when database query fails", async () => {
      const dbError = new Error("Database connection failed");
      mockDb.get.mockRejectedValue(dbError);

      await expect(repository.getUserSettings("@user:example.com")).rejects.toThrow("Database connection failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error retrieving settings for @user:example.com: Database connection failed"),
      );
    });
  });

  describe("saveIfNewer", () => {
    const userId = "@user:example.com";
    const payload = createTestPayload();
    const version = 1;
    const timestamp = 1234567890;
    const requestId = "req-123";

    it("saves in one write that keeps newer stored settings, and says it saved", async () => {
      mockDb.upsertIfNewer.mockResolvedValue([
        {
          matrix_id: userId,
        },
      ]);

      expect(await repository.saveIfNewer(userId, payload, version, timestamp, requestId)).toBe(true);
      expect(mockDb.upsertIfNewer).toHaveBeenCalledWith(
        "usersettings",
        {
          matrix_id: userId,
          settings: JSON.stringify(payload),
          version,
          timestamp,
          request_id: requestId,
        },
        "matrix_id",
        [
          "version",
          "timestamp",
        ],
      );
    });

    it("says it saved nothing when the stored settings are as recent or more", async () => {
      mockDb.upsertIfNewer.mockResolvedValue([]);

      expect(await repository.saveIfNewer(userId, payload, version, timestamp, requestId)).toBe(false);
    });

    it("throws when the write fails", async () => {
      mockDb.upsertIfNewer.mockRejectedValue(new Error("Database connection lost"));

      await expect(repository.saveIfNewer(userId, payload, version, timestamp, requestId)).rejects.toThrow(
        "Database connection lost",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to save settings for ${userId}: Database connection lost`),
      );
    });
  });

  describe("saveAvatar", () => {
    it("remembers the mxc URL of an avatar URL, whatever the version stored", async () => {
      mockDb.update.mockResolvedValue([]);

      await repository.saveAvatar("@user:example.com", "https://workspace.example.com/a.png", "mxc://example.com/a");

      expect(mockDb.update).toHaveBeenCalledWith(
        "usersettings",
        {
          avatar_source: "https://workspace.example.com/a.png",
          avatar_mxc: "mxc://example.com/a",
        },
        "matrix_id",
        "@user:example.com",
      );
    });
  });
});
