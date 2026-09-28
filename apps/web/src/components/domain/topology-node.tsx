import type { ComponentProps, ReactNode } from "react";
import { SelectionButton } from "@/components/ui/selection-button";

/** 坐标由拓扑布局提供；选择与焦点行为由基础控件提供。 */
export function TopologyNode({ label, icon, className, ...props }: Omit<ComponentProps<typeof SelectionButton>, "children"> & { label: string; icon: ReactNode }) {
  return <SelectionButton {...props} size="icon" aria-label={label} className={className}>
    {icon}<span className="absolute top-full mt-2 whitespace-nowrap text-xs text-foreground">{label}</span>
  </SelectionButton>;
}
