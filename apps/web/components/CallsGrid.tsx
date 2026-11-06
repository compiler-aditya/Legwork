'use client';

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { callResult, time, usd, type CallRow, type Plan } from '../lib/view';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Line {
  shop: string;
  round: string;
  attempt: number;
  result: string;
  quote: string;
  asked: string;
  started: string;
}

/** Every call as a row: who, which round, what happened, what they quoted. Two columns on a phone. */
export default function CallsGrid({ rows, plan }: { rows: CallRow[]; plan?: Plan }) {
  const narrow = useNarrow();
  const names = useMemo(() => new Map((plan?.shops ?? []).map((s) => [s.businessId, s.name])), [plan]);
  const data: Line[] = rows.map((r) => ({
    shop: names.get(r.businessId) ?? r.businessId,
    round: r.round === 2 ? 'Confirm' : 'Quote',
    attempt: r.attempt,
    result: `${narrow ? `${r.round === 2 ? 'Confirm' : 'Quote'}: ` : ''}${callResult(r)}${narrow && r.offer ? `; asked ${usd(r.offer.ask)}` : ''}`,
    quote: r.quote?.price ? usd(r.quote.price) : '',
    asked: r.offer ? `${usd(r.offer.ask)} (quoted ${usd(r.offer.quoted)})` : '',
    started: r.startedAt ? time(r.startedAt) : '',
  }));
  const columns: ColDef<Line>[] = narrow
    ? [
        { field: 'shop', headerName: 'Shop', flex: 2, wrapText: true, autoHeight: true },
        { field: 'result', headerName: 'What happened', flex: 3, wrapText: true, autoHeight: true },
      ]
    : [
        { field: 'shop', headerName: 'Shop', flex: 2, minWidth: 160 },
        { field: 'round', headerName: 'Call', width: 100 },
        { field: 'attempt', headerName: 'Try', width: 70 },
        { field: 'result', headerName: 'What happened', flex: 3, minWidth: 220 },
        { field: 'quote', headerName: 'Quote', width: 100 },
        { field: 'asked', headerName: 'Legwork asked', flex: 2, minWidth: 170 },
        { field: 'started', headerName: 'Started', width: 100 },
      ];
  return (
    <div style={{ width: '100%' }}>
      <AgGridReact<Line> theme={themeQuartz} rowData={data} columnDefs={columns} domLayout="autoHeight" suppressCellFocus />
    </div>
  );
}

function useNarrow(query = '(max-width: 640px)'): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return narrow;
}
