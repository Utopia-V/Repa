import { Badge } from "@/components/ui/badge";
import { SelectableCard } from "@/components/ui/selectable-card";
import { BookOpen, Network } from "lucide-react";

export type Knowledge = {
  title: string;
  category: string;
  text: string;
  count: string;
  icon: string;
};
export function KnowledgeCard({
  knowledge,
  selected,
  onSelect,
}: {
  knowledge: Knowledge;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = knowledge.icon === "nodes" ? Network : BookOpen;
  return (
    <SelectableCard selected={selected} onClick={onSelect}>
      <div className="flex items-center justify-between gap-3">
        <Icon className="size-5" />
        <Badge variant="outline">{knowledge.category}</Badge>
      </div>
      <h3 className="mt-3 text-base font-semibold text-card-foreground">{knowledge.title}</h3>
      <p className="mt-2 text-sm text-foreground">{knowledge.text}</p>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{knowledge.count}</span>
        <span>{selected ? "✓ 已选中" : "点击选择"}</span>
      </div>
    </SelectableCard>
  );
}
