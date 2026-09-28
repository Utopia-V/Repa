import { useId, type ComponentProps } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export function SearchInput({
  label,
  id,
  value,
  onClear,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "value"> & {
  label: string;
  value: string;
  onClear: () => void;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className={cn("grid gap-1", className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative flex items-center">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
        <Input {...props} id={inputId} value={value} className="rounded-full pl-10 pr-12" />
        {value && (
          <Button variant="ghost" size="icon" aria-label="清空搜索" className="absolute right-1" onClick={onClear}>
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
