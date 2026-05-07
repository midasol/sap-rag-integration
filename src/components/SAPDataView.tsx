'use client';

interface SAPDataViewProps {
  data: Record<string, unknown>[];
  title?: string;
}

export function SAPDataView({ data, title }: SAPDataViewProps) {
  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);

  return (
    <div className="mt-4 overflow-x-auto">
      {title && (
        <h4 className="text-sm font-semibold text-foreground mb-2">{title}</h4>
      )}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th key={col} className="text-left py-2 px-3 font-medium text-muted-foreground whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
              {columns.map((col) => (
                <td key={col} className="py-2 px-3 text-foreground whitespace-nowrap">
                  {String(row[col] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
