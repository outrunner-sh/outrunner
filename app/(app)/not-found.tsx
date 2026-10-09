import { RouteMessage } from "@/components/route-states";

/** A session (or page) that is not there: deleted, or a stale link. */
export default function NotFound() {
  return (
    <RouteMessage
      title="Nothing here"
      detail="This session may have been deleted, or the link is out of date."
    />
  );
}
