import { RouteLoading } from "@/components/route-states";

/**
 * What a page load shows until its server-read parts arrive (Cache Components
 * needs a Suspense boundary above anything read per request: here, every
 * layout's and page's). The app's own pages show their shell sooner, from
 * their own boundaries.
 */
export default function Loading() {
  return <RouteLoading label="Loading" />;
}
