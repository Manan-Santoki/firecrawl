"use client";

import { type ColumnDef, flexRender, type RowData, tableFeatures, useTable } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { CardFrame } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const features = tableFeatures({});

export type DataColumn<TData extends RowData> = ColumnDef<typeof features, TData> & {
  meta?: { className?: string };
};

/** TanStack Table state rendered with coss Table primitives inside a CardFrame. */
export function DataTable<TData extends RowData>({
  columns,
  data,
  empty,
  getRowId,
  onRowClick,
  testId,
  footer,
}: {
  columns: DataColumn<TData>[];
  data: TData[];
  empty: ReactNode;
  getRowId?: (row: TData) => string;
  onRowClick?: (row: TData) => void;
  testId?: string;
  footer?: ReactNode;
}) {
  const table = useTable({
    features,
    columns,
    data,
    getRowId: getRowId ? (row: TData) => getRowId(row) : undefined,
  });

  const rows = table.getRowModel().rows;

  return (
    <CardFrame className="w-full">
      <Table variant="card" data-testid={testId}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={(header.column.columnDef as DataColumn<TData>).meta?.className}
                >
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-testid={testId ? `${testId}-row` : undefined}
                className={cn(onRowClick && "cursor-pointer")}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={(cell.column.columnDef as DataColumn<TData>).meta?.className}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {footer}
    </CardFrame>
  );
}
