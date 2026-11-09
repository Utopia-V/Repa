import { useId, type ComponentProps } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { typeClass } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { t } from "@/lib/strings";

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
      <label htmlFor={inputId} className={cn(typeClass("body"), "text-foreground")}>
        {label}
      </label>
      <div className="relative flex items-center">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
        <Input {...props} id={inputId} value={value} className="pl-9 pr-10" />
        {value && (
          <Button variant="ghost" size="icon-compact" aria-label={t("sidebar.search.clear.label")} className="absolute right-1" onClick={onClear}>
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
