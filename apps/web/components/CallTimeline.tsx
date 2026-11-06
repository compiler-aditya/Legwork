'use client';

import { StringHelper } from '@bryntum/scheduler';
import { BryntumScheduler } from '@bryntum/scheduler-react';
import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/svalbard-light.css';
import '@bryntum/scheduler/fontawesome/css/fontawesome.css';
import '@bryntum/scheduler/fontawesome/css/solid.css';
import { useEffect, useState } from 'react';
import type { TimelineData } from '../lib/view';

const ROW = 46;
const HEADERS = 72;

/**
 * The calls on a timeline: one row per shop, one bar per call, coloured by how
 * it ended; a live call grows until it ends. Read-only, fitted to the width.
 */
export default function CallTimeline({ data }: { data: TimelineData }) {
  const narrow = useNarrow();
  return (
    <div className="timeline" style={{ height: HEADERS + ROW * Math.max(1, data.resources.length) + 2 }}>
      <BryntumScheduler
        readOnly
        forceFit
        eventStyle="filled"
        viewPreset={{
          base: 'minuteAndHour',
          tickWidth: 40,
          headers: [
            { unit: 'hour', dateFormat: 'ddd h A' },
            { unit: 'minute', increment: narrow ? 10 : 2, dateFormat: 'h:mm' },
          ],
        }}
        startDate={data.start}
        endDate={data.end}
        rowHeight={ROW}
        barMargin={8}
        columns={[{ text: 'Shop', field: 'name', width: narrow ? 120 : 190 }]}
        resources={data.resources}
        events={data.events}
        eventRenderer={({ eventRecord }) => StringHelper.encodeHtml(String(eventRecord.name))}
      />
    </div>
  );
}

export function useNarrow(query = '(max-width: 640px)'): boolean {
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
