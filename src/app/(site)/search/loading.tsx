import { Container } from '@/components/site/container'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * What the reader sees while a search is being run.
 *
 * ## When this is shown
 *
 * Only when the wait is long enough to be worth it, which is React's rule
 * rather than this file's: the server flushes the page shell as soon as the
 * render suspends on the search, so a query that answers in a millisecond never
 * produces a fallback at all — the whole page arrives in one piece and the
 * reader sees the results without a flicker of grey. When the query is slow,
 * the shell is already on its way and the skeleton fills the gap. That is the
 * behaviour the brief asks for: render on the server, and put a skeleton in
 * front of the wait that is left.
 *
 * (Delaying the response in a test does not reproduce it, which is worth
 * knowing before someone tries: the client router holds the old page until the
 * payload arrives, so the skeleton appears only when the *server render* is
 * slow, not when the network is.)
 *
 * ## Why this page has one and the rest of the site does not
 *
 * A `loading.tsx` is not free. It replaces the previous page the moment a
 * navigation starts, and for most of this site that trade is a loss: the routes
 * are one indexed query each, the reader is usually moving from one article to
 * another, and a skeleton over a page they were still reading is worse than
 * waiting. Search is the exception on both counts — it is the heaviest read on
 * the site, and it is the one page whose content the reader has just asked to
 * replace, so the old page is stale by definition.
 *
 * ## Why bars and not the real header
 *
 * The frame is sketched rather than rendered. Pulling the page's own header and
 * form in here would mean either importing the page module — which would drag
 * the search index and the database into the loading state — or keeping a second
 * copy of the copy, which is a copy that can drift. The bars are laid out at the
 * heights the real elements occupy, so the page does not jump when they are
 * replaced, and nothing here is focusable: a search input that appears mid
 * navigation and takes focus would be stealing it from wherever the reader was.
 */
export default function SearchLoading() {
  return (
    <Container>
      {/*
        One announcement for the whole region rather than one per bar. `Skeleton`
        is `aria-hidden`, so without this a screen reader would be told nothing
        at all — and "searching" is the one thing there is to say.
      */}
      <p role="status" className="sr-only">
        Searching…
      </p>

      {/*
        The heights are the line heights of the elements they stand in for —
        `h-8`/`sm:h-9` is a `text-2xl`/`sm:text-3xl` heading, `h-7` is the
        `text-lg` search field — so that replacing one with the other does not
        move anything below it. Everything inside is `aria-hidden`; the status
        line above is the only part a screen reader hears.
      */}
      <div aria-hidden="true">
        <header className="border-b border-line pb-6 pt-12 sm:pt-16">
          <Skeleton className="h-8 w-40 sm:h-9" />
          <Skeleton className="mt-3 h-5 w-full max-w-[62ch]" />
          <Skeleton className="mt-4 h-4 w-64" />
        </header>

        <div className="mt-8 border-b border-line pb-3">
          <Skeleton className="h-7 w-56" />
        </div>

        <ul className="flex flex-col pt-4">
          {Array.from({ length: 5 }, (_, index) => (
            <li key={index} className="border-b border-line py-6 last:border-b-0">
              {/* The metadata line, the title and the excerpt: the three
                  stacked parts of a result, in the order they arrive. */}
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-5 w-2/3" />
              <Skeleton className="mt-2 h-5 w-full max-w-[70ch]" />
            </li>
          ))}
        </ul>
      </div>
    </Container>
  )
}
