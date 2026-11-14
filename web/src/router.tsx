import { Suspense, lazy, useEffect, useRef } from 'react'
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { ArchivePage } from './pages/ArchivePage'
import { ArticlePage } from './pages/ArticlePage'
import { FriendsPage } from './pages/FriendsPage'
import { HomePage } from './pages/HomePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { NotesPage } from './pages/NotesPage'
import { PostsPage } from './pages/PostsPage'
import { PreviewPage } from './pages/PreviewPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SearchPage } from './pages/SearchPage'
import { SeriesDetailPage, SeriesPage } from './pages/SeriesPage'
import { CategoryDetailPage, TagDetailPage, TagsPage } from './pages/TagsPage'

const LazyGraphPage = lazy(() => import('./pages/GraphPage'))
const LazyAdminApp = lazy(() => import('./admin/AdminApp'))

function RootShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const prevPathRef = useRef<string | null>(null)

  useEffect(() => {
    if (prevPathRef.current === null) {
      prevPathRef.current = pathname
      return
    }
    if (prevPathRef.current !== pathname) {
      prevPathRef.current = pathname
      // Shift focus programmatically to the updated page heading after SPA transition finishes
      requestAnimationFrame(() => {
        const heading = document.getElementById('page-heading')
        heading?.focus({ preventScroll: true })
      })
    }
  }, [pathname])

  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}

const rootRoute = createRootRoute({
  component: RootShell,
  notFoundComponent: NotFoundPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

const postsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/posts',
  component: PostsPage,
})

const postDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/posts/$slug',
  component: function PostDetailRoute() {
    const { slug } = postDetailRoute.useParams()
    return <ArticlePage docType="post" slug={slug} />
  },
})

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes',
  component: NotesPage,
})

const noteDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes/$slug',
  component: function NoteDetailRoute() {
    const { slug } = noteDetailRoute.useParams()
    return <ArticlePage docType="note" slug={slug} />
  },
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
})

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$slug',
  component: function ProjectDetailRoute() {
    const { slug } = projectDetailRoute.useParams()
    return <ArticlePage docType="project" slug={slug} />
  },
})

const seriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/series',
  component: SeriesPage,
})

const seriesDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/series/$series',
  component: function SeriesDetailRoute() {
    const { series } = seriesDetailRoute.useParams()
    return <SeriesDetailPage series={series} />
  },
})

const tagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tags',
  component: TagsPage,
})

const tagDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tags/$tag',
  component: function TagDetailRoute() {
    const { tag } = tagDetailRoute.useParams()
    return <TagDetailPage tag={tag} />
  },
})

const categoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories/$category',
  component: function CategoryDetailRoute() {
    const { category } = categoryDetailRoute.useParams()
    return <CategoryDetailPage category={category} />
  },
})

const archiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/archive',
  component: ArchivePage,
})

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graph',
  component: function GraphRoute() {
    return (
      <Suspense fallback={<div className="editorial-card h-96 animate-pulse" />}>
        <LazyGraphPage />
      </Suspense>
    )
  },
})

const friendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/friends',
  component: FriendsPage,
})

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: (raw: Record<string, unknown>): { q?: string } => ({
    q: typeof raw.q === 'string' ? raw.q : undefined,
  }),
  component: function SearchRoute() {
    const { q } = searchRoute.useSearch()
    return <SearchPage initialQuery={q ?? ''} />
  },
})

const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/preview/$token',
  component: function PreviewRoute() {
    const { token } = previewRoute.useParams()
    return <PreviewPage token={token} />
  },
})

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: function AdminRoute() {
    return (
      <Suspense fallback={<div className="editorial-card h-80 animate-pulse" />}>
        <LazyAdminApp />
      </Suspense>
    )
  },
})

const adminCatchAllRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/$',
  component: function AdminSubRoute() {
    return (
      <Suspense fallback={<div className="editorial-card h-80 animate-pulse" />}>
        <LazyAdminApp />
      </Suspense>
    )
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  postsRoute,
  postDetailRoute,
  notesRoute,
  noteDetailRoute,
  projectsRoute,
  projectDetailRoute,
  seriesRoute,
  seriesDetailRoute,
  tagsRoute,
  tagDetailRoute,
  categoryDetailRoute,
  archiveRoute,
  graphRoute,
  friendsRoute,
  searchRoute,
  previewRoute,
  adminRoute,
  adminCatchAllRoute,
])

export const router = createRouter({
  routeTree,
  defaultViewTransition: true,
  scrollRestoration: true,
})
