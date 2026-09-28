import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LearningUpload } from "../src/components/domain/learning-upload";

afterEach(cleanup);

it("拖拽和选择材料可去重、移除，学习入口暂不可用", () => {
  render(<LearningUpload />);
  const file = new File(["学习内容"], "材料.txt", { type: "text/plain" });
  const input = screen.getByLabelText(/把学习材料拖到这里/) as HTMLInputElement;
  fireEvent.drop(input.closest("label")!, { dataTransfer: { files: [file] } });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getAllByText("材料.txt")).toHaveLength(1);
  expect(screen.getByRole("status").textContent).toBe("已选择 1 份材料");
  fireEvent.click(screen.getByRole("button", { name: "开始学习" }));
  expect((screen.getByRole("button", { name: "开始学习" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("已选择 1 份材料");
  fireEvent.click(screen.getByRole("button", { name: "移除 材料.txt" }));
  expect(screen.queryByText("材料.txt")).toBeNull();
});
