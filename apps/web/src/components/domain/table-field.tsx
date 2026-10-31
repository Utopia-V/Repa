import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MarkBadge, rowName, type FieldProps, type Slot, type TableDraft } from "@/components/domain/item-parts";

type TableSlot = Extract<Slot, { type: "table" }>;

/**
 * 表格题：固定文字的单元格按行内 Markdown 显示，输入格是文本框或下拉选择。窄屏时表格自己横向滚动。
 * 每个输入格的可访问名称由行标题和列标题组成；判分标记的键是“行 id/列 id”。
 */
export function TableField({ slot, value, onChange, labelId, invalid, describedBy, disabled, marks }: FieldProps<TableSlot, TableDraft>) {
  const rowHeaders = slot.rows.some((row) => row.header !== undefined);

  function set(row: string, column: string, text: string) {
    onChange({ ...value, cells: { ...value.cells, [row]: { ...value.cells[row], [column]: text } } });
  }

  return <div className="min-w-0 overflow-x-auto" aria-describedby={describedBy}>
    <table aria-labelledby={labelId} className="border-collapse text-sm">
      <thead>
        <tr>
          {rowHeaders && <td className="border border-border px-2 py-1" />}
          {slot.columns.map((column) => <th key={column.id} scope="col" className="border border-border px-2 py-1 text-left align-top font-semibold">
            <Markdown text={column.header} math={false} />
          </th>)}
        </tr>
      </thead>
      <tbody>
        {slot.rows.map((row, rowIndex) => <tr key={row.id}>
          {rowHeaders && <th scope="row" className="border border-border px-2 py-1 text-left align-top font-semibold">
            {row.header !== undefined && <Markdown text={row.header} math={false} />}
          </th>}
          {slot.columns.map((column) => {
            const cell = row.cells[column.id];
            const mark = marks?.[`${row.id}/${column.id}`];
            if (!cell) return <td key={column.id} className="border border-border px-2 py-1" />;
            if ("value" in cell) {
              return <td key={column.id} className="border border-border px-2 py-1 align-top"><Markdown text={cell.value} math={false} /></td>;
            }
            const label = `${rowName(row, rowIndex)}，${column.header}`;
            const text = value.cells[row.id]?.[column.id] ?? "";
            return <td key={column.id} className="border border-border px-2 py-1 align-top">
              <div className="flex min-w-32 items-center gap-2">
                {cell.input.type === "text"
                  ? <Input aria-label={label} aria-invalid={invalid || undefined} value={text} disabled={disabled} onChange={(event) => set(row.id, column.id, event.target.value)} />
                  : <Select value={text} disabled={disabled} onValueChange={(next) => set(row.id, column.id, next)}>
                    <SelectTrigger aria-label={label} aria-invalid={invalid || undefined} className="w-full"><SelectValue placeholder="选择" /></SelectTrigger>
                    <SelectContent>
                      {cell.input.options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
                    </SelectContent>
                  </Select>}
                <MarkBadge mark={mark} />
              </div>
            </td>;
          })}
        </tr>)}
      </tbody>
    </table>
  </div>;
}
