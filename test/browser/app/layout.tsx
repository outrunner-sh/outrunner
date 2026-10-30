import { Suspense } from "react";
import RootLayout from "../../../app/layout";
import { FixtureFrame } from "../fixture-frame";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <RootLayout>
      <Suspense><FixtureFrame>{children}</FixtureFrame></Suspense>
    </RootLayout>
  );
}
