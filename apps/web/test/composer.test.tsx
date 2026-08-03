import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer";

describe("消息编辑器附件", () => {
  it("选择图片后随消息提交，并允许移除附件", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer disabled={false} running={false} onSend={onSend} onStop={async () => undefined} />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("添加附件").previousElementSibling as HTMLInputElement, file);
    await waitFor(() => expect(screen.getByText(/screen\.png/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "移除附件 screen.png" }));
    expect(screen.queryByText(/screen\.png/)).not.toBeInTheDocument();
    await user.upload(screen.getByLabelText("添加附件").previousElementSibling as HTMLInputElement, file);
    await waitFor(() => expect(screen.getByText(/screen\.png/)).toBeInTheDocument());
    await user.type(screen.getByTestId("composer-input"), "请查看图片");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(onSend).toHaveBeenCalledWith("请查看图片", expect.arrayContaining([expect.objectContaining({ name: "screen.png", kind: "image" })]));
    expect(screen.queryByText(/screen\.png/)).not.toBeInTheDocument();
  });
});
