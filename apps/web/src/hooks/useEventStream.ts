import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

/** Status events pushed over SSE from the API (see apps/api/src/services/events.ts). */
export type FieldEvent =
  | {
      type: 'job';
      jobId: string;
      status: string;
      paperId?: string | null;
      progress?: string | null;
      error?: string | null;
      at: string;
    }
  | { type: 'paper'; paperId: string; status: string; progress: number; at: string };

/**
 * Subscribe to the API's live status stream for the lifetime of the component.
 * One EventSource per mount; the callback is kept in a ref so the connection is
 * not torn down and re-opened on every render.
 */
export function useEventStream(onEvent: (event: FieldEvent) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    const source = new EventSource(api.ingest.streamUrl());
    const handler = (e: MessageEvent) => {
      try {
        cb.current(JSON.parse(e.data) as FieldEvent);
      } catch {
        // ignore malformed frames (e.g. heartbeats)
      }
    };
    source.addEventListener('job', handler);
    source.addEventListener('paper', handler);
    return () => source.close();
  }, []);
}
