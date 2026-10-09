import { RouteLoading } from "@/components/route-states";

/** While the server reads the session: shown at once, inside the layout, so a
 *  click in the sidebar always answers. */
export default function Loading() {
  return <RouteLoading label="Opening session" />;
}
