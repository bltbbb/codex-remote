import { describe, expect, it } from "vitest";
import { createRemoteId } from "../src/id";

describe("远程协议 ID", () => {
  it("在缺少 randomUUID 时生成 UUID v4", () => {
    const id = createRemoteId({
      getRandomValues(bytes) {
        bytes.fill(1);
        return bytes;
      },
    });

    expect(id).toBe("01010101-0101-4101-8101-010101010101");
  });
});
