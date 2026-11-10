import { lazy, Suspense, useSyncExternalStore } from 'react'

// Each route is its own chunk: the workspace never loads Three.js or audio code,
// and the intro keeps its existing behaviour.
const IntroRoute = lazy(() => import('./IntroRoute'))
const Workspace = lazy(() => import('./workspace/Workspace'))

type Route = 'intro' | 'workspace'

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const currentRoute = (): Route => (/^#\/workspace\/?$/.test(window.location.hash) ? 'workspace' : 'intro')

/** Rendered outside the Canvas and pointer lock; keyboard users reach it first. */
function SkipIntro() {
  return <a className="skip-intro" href="#/workspace">Skip intro and open repair workspace</a>
}

export default function AppRouter() {
  const route = useSyncExternalStore(subscribe, currentRoute)
  if (route === 'workspace') {
    return (
      <Suspense fallback={<p className="route-loading" role="status">Opening workspace…</p>}>
        <Workspace />
      </Suspense>
    )
  }
  return (
    <>
      <SkipIntro />
      <Suspense fallback={null}>
        <IntroRoute />
      </Suspense>
    </>
  )
}
