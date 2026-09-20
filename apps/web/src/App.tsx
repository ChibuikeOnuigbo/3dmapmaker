/**
 * apps/web — route shell.
 *
 * Four surfaces, all real pages:
 *   #/            marketing landing page (REQUIREMENT 136)
 *   #/editor      the workbench
 *   #/tutorial    the static, text+diagram tutorial (REQUIREMENT 134)
 *   #/qa          the in-browser QA harness + benchmark runner (REQ 140/141)
 *   #/worlds      the connected panorama world (8×8 / 20×20 / 32×32)
 *
 * Routing is hash-based so the static build works from any host or file path.
 */
import React, { useEffect, useRef, useState } from 'react';
import { TooltipProvider } from '@3dmm/ui';
import { LandingPage } from './ui/LandingPage';
import { Workbench } from './ui/Workbench';
import { StaticTutorial } from './ui/StaticTutorial';
import { QaPage } from './qa/QaPage';
import { PanoramaWorldPage } from './ui/PanoramaWorldPage';
import { useStore } from './state/store';

export type Route = 'landing' | 'editor' | 'tutorial' | 'qa' | 'worlds';

const VALID: Route[] = ['landing', 'editor', 'tutorial', 'qa', 'worlds'];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
  return (VALID as string[]).includes(raw) ? (raw as Route) : 'landing';
}

/** Screen-reader-facing name for each route, used by the shell live region. */
export const ROUTE_LABEL: Record<Route, string> = {
  landing: '3DMapMaker Next, home',
  editor: 'Workbench',
  tutorial: 'Tutorial',
  qa: 'QA harness',
  worlds: 'Panorama worlds',
};

export function navigate(route: Route): void {
  const next = `#/${route}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const recoveryWarnings = useStore((s) => s.recoveryWarnings);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // An autosave recovery is worth one visible notice, not a silent surprise.
  useEffect(() => {
    if (recoveryWarnings.length === 0) return;
    const s = useStore.getState();
    s.notify('warn', `Recovered an autosaved world. ${recoveryWarnings.length} issue(s) were repaired.`);
    useStore.setState({ recoveryWarnings: [] });
  }, [recoveryWarnings]);

  // Hash routing changes the whole page without a document navigation, so a
  // screen reader gets no announcement when a nav link is followed. This region
  // supplies one. The first render is deliberately not announced — the page's
  // own h1 already covers it, and repeating it would double-speak on load.
  const announced = useRef(route);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (announced.current === route) return;
    announced.current = route;
    setAnnouncement(ROUTE_LABEL[route]);
  }, [route]);

  return (
    <TooltipProvider>
      <div aria-live="polite" role="status" className="visually-hidden" data-qa="route-announcer">
        {announcement}
      </div>
      {route === 'landing' && <LandingPage onOpenEditor={() => navigate('editor')} />}
      {route === 'editor' && <Workbench />}
      {route === 'tutorial' && <StaticTutorial />}
      {route === 'qa' && <QaPage />}
      {route === 'worlds' && <PanoramaWorldPage />}
    </TooltipProvider>
  );
}

export default App;
