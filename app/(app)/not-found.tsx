import { RouteMessage } from "@/components/route-states";

/** A link to nothing: mistyped, out of date, or another account's. */
export default function NotFound() {
  return (
    <RouteMessage
      title="Nothing at this link"
      detail="It may be out of date, or belong to another account."
      actions={[{ label: "Back to sessions", href: "/", primary: true }]}
    />
  );
}
