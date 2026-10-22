import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ActiveDocumentController, isDirty } from './active-document';
import type { WorkbenchEnvironment } from './active-document';

/** How long edits rest before they are saved, as the mind map's own autosave does. */
const AUTOSAVE_DELAY_MS = 1200;

/** The document open in the workbench, saved a moment after each edit. */
export function useActiveDocument(environment: WorkbenchEnvironment) {
  const latest = useRef(environment);
  latest.current = environment;
  const [controller] = useState(
    () =>
      new ActiveDocumentController(invoke, {
        getSnapshot: () => latest.current.getSnapshot(),
        installSnapshot: (snapshot) => latest.current.installSnapshot(snapshot),
        refreshList: () => latest.current.refreshList(),
        setStatus: (message) => latest.current.setStatus(message),
        setError: (message) => latest.current.setError(message),
        confirmDiscard: (message) => latest.current.confirmDiscard(message),
      }),
  );
  const active = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
  );
  const dirty = isDirty(active);

  // A save that failed is not retried until the next edit, which changes the revision.
  useEffect(() => {
    if (!dirty) return undefined;
    const timer = window.setTimeout(() => {
      void controller.save();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [controller, dirty, active?.revision, active?.savedRevision]);

  return { controller, active, dirty };
}
