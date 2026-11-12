import type { ReactNode } from "react";
import { Banner, BannerDescription, BannerTitle } from "./banner";

export function StatusNotice({
  status,
  title,
  children,
}: {
  status: "complete" | "error";
  title: string;
  children?: ReactNode;
}) {
  return (
    <Banner status={status === "complete" ? "success" : "error"} contrast="high">
      <BannerTitle>{title}</BannerTitle>
      {children && <BannerDescription>{children}</BannerDescription>}
    </Banner>
  );
}
