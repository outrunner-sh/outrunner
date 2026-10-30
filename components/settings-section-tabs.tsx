"use client";
import { useState } from "react";
import { SettingsTabs } from "@/components/settings-tabs";
import { replaceAddressBar } from "@/lib/client/address-bar";
export function SettingsSectionTabs({
  labels,
  initial,
  children,
  prefix,
}: {
  labels: [string, string];
  initial: "first" | "second";
  children: [React.ReactNode, React.ReactNode];
  prefix: string;
}) {
  const [active, setActive] = useState(initial);
  return (
    <div className="space-y-6">
      <SettingsTabs
        ids={["first", "second"]}
        active={active}
        onOpen={(tab) => {
          setActive(tab);
          const url = new URL(window.location.href);
          url.searchParams.set(
            "tab",
            tab === "second"
              ? prefix === "members"
                ? "roles"
                : "webhooks"
              : prefix === "members"
                ? "members"
                : "keys",
          );
          replaceAddressBar(`${url.pathname}${url.search}${url.hash}`);
        }}
        label={prefix === "members" ? "Members & access" : "Developer"}
        idPrefix={prefix}
        tabLabel={(id) => labels[id === "first" ? 0 : 1]}
      />
      {children.map((child, i) => (
        <div
          key={i}
          role="tabpanel"
          id={`${prefix}-panel-${i === 0 ? "first" : "second"}`}
          aria-labelledby={`${prefix}-tab-${i === 0 ? "first" : "second"}`}
          hidden={active !== (i === 0 ? "first" : "second")}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
