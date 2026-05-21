import { describe, test, expect } from "vitest";
import { redisKey } from "../../src/utils/redisKeys.js";

describe("redisKey generators", () => {
  test("cartKey generates correct format", () => {
    expect(redisKey.cartKey("user-alice")).toBe("cart:user-user-alice");
  });

  test("inventoryKey generates correct format", () => {
    expect(redisKey.inventoryKey(1)).toBe("inventory:product-1");
    expect(redisKey.inventoryKey("42")).toBe("inventory:product-42");
  });

  test("cartEntry generates correct format", () => {
    const entry = redisKey.cartEntry(1, "abc-123");
    expect(entry).toBe("1:rev-abc-123");
  });

  test("reservationKey generates correct format", () => {
    const key = redisKey.reservationKey(1, "user-alice", "abc-123");
    expect(key).toBe("reservation:product:1:user-user-alice:rev-abc-123");
  });

  test("reservationKey with different inputs produces unique keys", () => {
    const key1 = redisKey.reservationKey(1, "user-alice", "uuid-1");
    const key2 = redisKey.reservationKey(1, "user-alice", "uuid-2");
    const key3 = redisKey.reservationKey(2, "user-alice", "uuid-1");
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});
